import {
	command,
	default as CookiecordClient,
	listener,
	Module,
	optional,
} from 'cookiecord';
import { Message, MessageEmbed, TextChannel, User } from 'discord.js';
import {
	compressToEncodedURIComponent,
	decompressFromEncodedURIComponent,
} from 'lz-string';
import fetch from 'node-fetch';
import { format } from 'prettier';
import { URLSearchParams } from 'url';
import { TS_BLUE } from '../env';
import {
	makeCodeBlock,
	findCodeblockFromChannel,
	PLAYGROUND_REGEX,
} from '../util/findCodeblockFromChannel';
import { LimitedSizeMap } from '../util/limitedSizeMap';
import { addMessageOwnership, sendWithMessageOwnership } from '../util/send';

const LINK_SHORTENER_ENDPOINT = 'https://tsplay.dev/api/short';
const MAX_EMBED_LENGTH = 512;
const DEFAULT_EMBED_LENGTH = 256;

export class PlaygroundModule extends Module {
	constructor(client: CookiecordClient) {
		super(client);
	}

	private editedLongLink = new LimitedSizeMap<string, Message>(1000);

	@command({
		aliases: ['pg', 'playg'],
		single: true,
		description: 'Shorten a TypeScript playground link',
	})
	async playground(msg: Message, @optional code?: string) {
		const PLAYGROUND_BASE = 'https://www.typescriptlang.org/play/#code/';

		if (!code) {
			code = await findCodeblockFromChannel(
				msg.channel as TextChannel,
				true,
			);
			if (!code)
				return sendWithMessageOwnership(
					msg,
					":warning: couldn't find a codeblock!",
				);
		}
		const embed = new MessageEmbed()
			.setURL(PLAYGROUND_BASE + compressToEncodedURIComponent(code))
			.setTitle('View in Playground')
			.setColor(TS_BLUE);
		await sendWithMessageOwnership(msg, { embed });
	}

	@listener({ event: 'message' })
	async onPlaygroundLinkMessage(msg: Message) {
		if (msg.author.bot) return;
		const exec = PLAYGROUND_REGEX.exec(msg.content);
		if (!exec) return;
		const embed = createPlaygroundEmbed(msg.author, exec);
		if (exec[0] === msg.content) {
			// Message only contained the link
			await sendWithMessageOwnership(msg, { embed });
			await msg.delete();
		} else {
			// Message also contained other characters
			const botMsg = await msg.channel.send(
				`${msg.author} Here's a shortened URL of your playground link! You can remove the full link from your message.`,
				{ embed },
			);
			this.editedLongLink.set(msg.id, botMsg);
			await addMessageOwnership(botMsg, msg.author);
		}
	}

	@listener({ event: 'message' })
	async onPlaygroundLinkAttachment(msg: Message) {
		const attachment = msg.attachments.find(a => a.name === 'message.txt');
		if (msg.author.bot || !attachment) return;
		const content = await fetch(attachment.url).then(r => r.text());
		const exec = PLAYGROUND_REGEX.exec(content);
		// By default, if you write a message in the box and then paste a long
		// playground link, it will only put the paste in message.txt and will
		// put the rest of the message in msg.content
		if (!exec || exec[0] !== content) return;
		const shortenedUrl = await shortenPlaygroundLink(exec[0]);
		const embed = createPlaygroundEmbed(msg.author, exec, shortenedUrl);
		await sendWithMessageOwnership(msg, { embed });
		if (!msg.content) await msg.delete();
	}

	@listener({ event: 'messageUpdate' })
	async onLongFix(_oldMsg: Message, msg: Message) {
		if (msg.partial) await msg.fetch();
		const exec = PLAYGROUND_REGEX.exec(msg.content);
		if (msg.author.bot || !this.editedLongLink.has(msg.id) || exec) return;
		const botMsg = this.editedLongLink.get(msg.id);
		await botMsg?.edit('');
		this.editedLongLink.delete(msg.id);
	}
}

function createPlaygroundEmbed(
	author: User,
	[_url, query, code]: RegExpExecArray,
	url: string = _url,
) {
	const embed = new MessageEmbed()
		.setColor(TS_BLUE)
		.setTitle('Shortened Playground Link')
		.setAuthor(author.tag, author.displayAvatarURL())
		.setURL(url)
		.setFooter(
			'You can choose specific lines to embed by selecting them before copying the link.',
		);

	const unzipped = decompressFromEncodedURIComponent(code);
	if (!unzipped) return embed;

	const lines = unzipped.split('\n');
	const lineLengths = lines.map(l => l.length);
	const cumulativeLineLengths = lineLengths.reduce(
		(acc, len, i) => {
			acc.push(len + acc[i] + '\n'.length);
			return acc;
		},
		[0],
	);
	const selection = getSelectionFromQuery(query);
	const { startLine, startColumn, endLine, endColumn } = selection;
	const startChar = cumulativeLineLengths[startLine ?? 0];
	const cll = cumulativeLineLengths;
	// This is calculated more often than necessary to avoid some absolutely
	// hideous Prettier formatting if it is inlined at the single call site.
	const cutoff = Math.min(startChar + DEFAULT_EMBED_LENGTH, unzipped.length);
	const endChar = endLine
		? cumulativeLineLengths[endLine]
		: cumulativeLineLengths.find(len => len > cutoff) ??
		  cumulativeLineLengths[cumulativeLineLengths.length - 1];
	const pretty = format(unzipped, {
		parser: 'typescript',
		printWidth: 55,
		tabWidth: 2,
		semi: false,
		bracketSpacing: false,
		arrowParens: 'avoid',
		rangeStart: startChar,
		rangeEnd: endChar,
	});
	const prettyEnd = pretty.length - (unzipped.length - endChar);
	const maxEnd = Math.min(prettyEnd, startChar + MAX_EMBED_LENGTH);
	const extract = pretty.slice(startChar, maxEnd);

	console.log('SELECTION:', selection);
	console.log({ startChar, endChar });
	console.log(
		'LENGTH: unzipped, pretty, extract:',
		unzipped.length,
		pretty.length,
		extract.length,
	);
	return embed.setDescription(makeCodeBlock(extract)); //.setTitle(`${extract.length} chars`);
}

async function shortenPlaygroundLink(url: string) {
	const response = await fetch(LINK_SHORTENER_ENDPOINT, {
		method: 'post',
		body: JSON.stringify({ url, createdOn: 'api', expires: false }),
		headers: {
			'Content-Type': 'application/json',
		},
	});
	const { shortened } = await response.json();
	if (typeof shortened !== 'string')
		throw new Error('Received invalid api response from link shortener');
	return shortened;
}

function getSelectionFromQuery(query: string) {
	const params = new URLSearchParams(query);
	const cursorPosition = {
		line: getPosFromPGURLParam(params, 'pln'),
		column: getPosFromPGURLParam(params, 'pc'),
	};
	const selectionPosition = {
		line: getPosFromPGURLParam(params, 'ssl'),
		column: getPosFromPGURLParam(params, 'ssc'),
	};
	// Sometimes the cursor is at the start of the selection, and other times
	// it's at the end of the selection; we don't care which, only that the
	// lower one always comes first.
	const [start, end] = [cursorPosition, selectionPosition].sort(
		(a, b) => (a.line ?? 0) - (b.line ?? 0),
	);
	return {
		startLine: start.line,
		startColumn: start.column,
		endLine: end.line,
		endColumn: end.column,
	};
}

function getPosFromPGURLParam(params: URLSearchParams, name: string) {
	const p = params.get(name);
	if (p === null) return undefined;
	const n = Number(p);
	return n === NaN || n < 1 ? undefined : n - 1; // lines/chars are 1-indexed :(
}
