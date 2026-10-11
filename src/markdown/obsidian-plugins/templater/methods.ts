import {
	concatLists,
	concatTexts,
	flatList,
	joinTexts,
	padText,
	repeatText,
	replaceText,
} from "../../interpreter-limits.js";
import { invoke } from "./interpreter.js";
import {
	binary,
	describe,
	FORBIDDEN_PROPERTIES,
	HostFunction,
	HostValue,
	isPlainObject,
	readProperty,
	TemplaterError,
	toNumber,
	toTemplateString,
} from "./values.js";

function callDateMethod(date: Date, name: string): unknown {
	switch (name) {
		case "getFullYear":
			return date.getFullYear();
		case "getMonth":
			return date.getMonth();
		case "getDate":
			return date.getDate();
		case "getDay":
			return date.getDay();
		case "getHours":
			return date.getHours();
		case "getMinutes":
			return date.getMinutes();
		case "getSeconds":
			return date.getSeconds();
		case "getMilliseconds":
			return date.getMilliseconds();
		case "getTime":
		case "valueOf":
			return date.getTime();
		case "toISOString":
		case "toJSON":
			return date.toISOString();
		case "toDateString":
			return date.toDateString();
		case "toTimeString":
			return date.toTimeString();
		case "toString":
			return date.toString();
	}
	throw new TemplaterError(`Unsupported method: ${name}() on a date.`);
}

async function replaceWith(
	text: string,
	pattern: unknown,
	replacement: unknown,
	all: boolean,
): Promise<string> {
	if (!(replacement instanceof HostFunction)) {
		const substitute = toTemplateString(replacement);
		if (pattern instanceof RegExp) {
			if (all && !pattern.global) throw new TemplaterError("replaceAll() needs a global regex.");
			return replaceText(text, pattern, substitute, false);
		}
		return replaceText(text, toTemplateString(pattern), substitute, all);
	}
	// A replacer callback: collect the matches, then call it for each in turn.
	const regex =
		pattern instanceof RegExp
			? new RegExp(pattern.source, all ? `${pattern.flags.replace("g", "")}g` : pattern.flags)
			: undefined;
	const matches: Array<{ index: number; groups: string[] }> = [];
	if (regex) {
		if (regex.global) {
			for (const match of text.matchAll(regex)) {
				matches.push({ index: match.index, groups: [...match].map((part) => part ?? "") });
			}
		} else {
			const match = regex.exec(text);
			if (match) matches.push({ index: match.index, groups: [...match].map((part) => part ?? "") });
		}
	} else {
		const search = toTemplateString(pattern);
		let from = text.indexOf(search);
		while (from >= 0) {
			matches.push({ index: from, groups: [search] });
			if (!all) break;
			from = text.indexOf(search, from + Math.max(1, search.length));
		}
	}
	let result = "";
	let cursor = 0;
	for (const match of matches) {
		const whole = match.groups[0] ?? "";
		result = concatTexts(result, text.slice(cursor, match.index));
		result = concatTexts(
			result,
			toTemplateString(await replacement.call([...match.groups, match.index, text])),
		);
		cursor = match.index + whole.length;
	}
	return result + text.slice(cursor);
}

async function callStringMethod(text: string, name: string, args: unknown[]): Promise<unknown> {
	const arg = (position: number) => toTemplateString(args[position] ?? "");
	const optionalNumber = (position: number) =>
		args[position] === undefined ? undefined : Number(args[position]);
	switch (name) {
		case "toUpperCase":
		case "toLocaleUpperCase":
			return text.toUpperCase();
		case "toLowerCase":
		case "toLocaleLowerCase":
			return text.toLowerCase();
		case "trim":
			return text.trim();
		case "trimStart":
			return text.trimStart();
		case "trimEnd":
			return text.trimEnd();
		case "includes":
		case "contains":
			return text.includes(arg(0));
		case "startsWith":
			return text.startsWith(arg(0), optionalNumber(1));
		case "endsWith":
			return text.endsWith(arg(0), optionalNumber(1));
		case "indexOf":
			return text.indexOf(arg(0), optionalNumber(1));
		case "lastIndexOf":
			return text.lastIndexOf(arg(0), optionalNumber(1));
		case "slice":
			return text.slice(Number(args[0] ?? 0), optionalNumber(1));
		case "substring":
			return text.substring(Number(args[0] ?? 0), optionalNumber(1));
		case "at":
			return text.at(Number(args[0] ?? 0));
		case "charAt":
			return text.charAt(Number(args[0] ?? 0));
		case "split": {
			const separator = args[0];
			if (separator === undefined) return [text];
			const limit = optionalNumber(1);
			return separator instanceof RegExp
				? text.split(separator, limit)
				: text.split(toTemplateString(separator), limit);
		}
		case "replace":
			return await replaceWith(text, args[0], args[1], false);
		case "replaceAll":
			return await replaceWith(text, args[0], args[1], true);
		case "match": {
			if (!(args[0] instanceof RegExp)) {
				throw new TemplaterError("match() needs a regular expression.");
			}
			const match = text.match(args[0]);
			return match ? [...match] : null;
		}
		case "search":
			return args[0] instanceof RegExp ? text.search(args[0]) : text.indexOf(arg(0));
		case "padStart":
			return padText(text, Number(args[0] ?? 0), args[1] === undefined ? " " : arg(1), false);
		case "padEnd":
			return padText(text, Number(args[0] ?? 0), args[1] === undefined ? " " : arg(1), true);
		case "repeat":
			return repeatText(text, Math.max(0, Number(args[0] ?? 0)));
		case "concat":
			return concatTexts(
				text,
				joinTexts(args, "", (value) => toTemplateString(value)),
			);
		case "localeCompare":
			return text.localeCompare(arg(0));
		case "normalize":
			return text.normalize();
		case "toString":
		case "valueOf":
			return text;
	}
	throw new TemplaterError(`Unsupported method: ${name}() on a string.`);
}

async function sortList(list: unknown[], compare: unknown): Promise<unknown[]> {
	if (compare === undefined) {
		return list.sort((left, right) => {
			const a = toTemplateString(left);
			const b = toTemplateString(right);
			return a < b ? -1 : a > b ? 1 : 0;
		});
	}
	// A merge sort, so the comparator can be awaited.
	const sorted = await mergeSort([...list], async (left, right) =>
		toNumber(await invoke(compare, [left, right])),
	);
	list.splice(0, list.length, ...sorted);
	return list;
}

async function mergeSort(
	list: unknown[],
	compare: (left: unknown, right: unknown) => Promise<number>,
): Promise<unknown[]> {
	if (list.length < 2) return list;
	const middle = Math.floor(list.length / 2);
	const left = await mergeSort(list.slice(0, middle), compare);
	const right = await mergeSort(list.slice(middle), compare);
	const merged: unknown[] = [];
	let i = 0;
	let j = 0;
	while (i < left.length && j < right.length) {
		if ((await compare(left[i], right[j])) <= 0) merged.push(left[i++]);
		else merged.push(right[j++]);
	}
	return merged.concat(left.slice(i), right.slice(j));
}

async function callArrayMethod(list: unknown[], name: string, args: unknown[]): Promise<unknown> {
	const fn = args[0];
	const each = async <T>(
		visit: (value: unknown, result: unknown, index: number) => T | undefined,
	): Promise<T | undefined> => {
		for (const [index, value] of list.entries()) {
			const outcome = visit(value, await invoke(fn, [value, index, list]), index);
			if (outcome !== undefined) return outcome;
		}
		return undefined;
	};
	switch (name) {
		case "map": {
			const mapped: unknown[] = [];
			for (const [index, value] of list.entries())
				mapped.push(await invoke(fn, [value, index, list]));
			return mapped;
		}
		case "filter": {
			const kept: unknown[] = [];
			for (const [index, value] of list.entries()) {
				if (await invoke(fn, [value, index, list])) kept.push(value);
			}
			return kept;
		}
		case "forEach":
			await each(() => undefined);
			return undefined;
		case "find":
			return (await each((value, result) => (result ? { value } : undefined)))?.value;
		case "findIndex":
			return (await each((_value, result, index) => (result ? { index } : undefined)))?.index ?? -1;
		case "some":
			return (await each((_value, result) => (result ? true : undefined))) ?? false;
		case "every":
			return !((await each((_value, result) => (result ? undefined : true))) ?? false);
		case "reduce": {
			let accumulator: unknown;
			let start = 0;
			if (args.length > 1) accumulator = args[1];
			else {
				if (list.length === 0)
					throw new TemplaterError("reduce() of an empty array needs a start value.");
				accumulator = list[0];
				start = 1;
			}
			for (let index = start; index < list.length; index += 1) {
				accumulator = await invoke(fn, [accumulator, list[index], index, list]);
			}
			return accumulator;
		}
		case "includes":
		case "contains":
			return list.some((value) => binary("===", value, args[0]));
		case "indexOf":
			return list.findIndex((value) => binary("===", value, args[0]));
		case "join":
			return joinTexts(list, args[0] === undefined ? "," : toTemplateString(args[0]), (value) =>
				value == null ? "" : toTemplateString(value),
			);
		case "slice":
			return list.slice(Number(args[0] ?? 0), args[1] === undefined ? undefined : Number(args[1]));
		case "concat":
			return concatLists([list, ...args.map((value) => (Array.isArray(value) ? value : [value]))]);
		case "reverse":
			return list.reverse();
		case "sort":
			return await sortList(list, fn);
		case "flat":
			return flatList(list, Math.max(0, Math.min(100, Number(args[0] ?? 1))));
		case "push":
			return list.push(...args);
		case "pop":
			return list.pop();
		case "shift":
			return list.shift();
		case "unshift":
			return list.unshift(...args);
		case "at":
			return list.at(Number(args[0] ?? 0));
		case "first":
			return list[0];
		case "last":
			return list[list.length - 1];
		case "unique":
			// A Set keeps first occurrences and compares as `===` does here (NaN equals NaN):
			// linear, where a pairwise scan of a long list would hang the build.
			return [...new Set(list)];
		case "toString":
			return toTemplateString(list);
	}
	throw new TemplaterError(`Unsupported method: ${name}() on an array.`);
}

export async function callMethod(
	receiver: unknown,
	name: string,
	args: unknown[],
): Promise<unknown> {
	if (FORBIDDEN_PROPERTIES.has(name)) {
		throw new TemplaterError(`\`${name}\` is not available to templates.`);
	}
	if (receiver instanceof HostValue) return await receiver.method(name, args);
	if (Array.isArray(receiver)) return await callArrayMethod(receiver, name, args);
	if (typeof receiver === "string") return await callStringMethod(receiver, name, args);
	if (typeof receiver === "number") {
		if (name === "toFixed") {
			return receiver.toFixed(Math.max(0, Math.min(100, Number(args[0] ?? 0) || 0)));
		}
		if (name === "toPrecision" && args[0] !== undefined) {
			return receiver.toPrecision(Math.max(1, Math.min(100, Number(args[0]))));
		}
		if (name === "toString") {
			const radix = Number(args[0] ?? 10);
			return receiver.toString(radix >= 2 && radix <= 36 ? radix : 10);
		}
	}
	if (typeof receiver === "boolean" && name === "toString") return String(receiver);
	if (receiver instanceof Date) return callDateMethod(receiver, name);
	if (receiver instanceof RegExp) {
		if (name === "test") {
			receiver.lastIndex = 0;
			return receiver.test(toTemplateString(args[0]));
		}
		if (name === "toString") return receiver.toString();
	}
	if (isPlainObject(receiver)) {
		const member = readProperty(receiver, name);
		if (member instanceof HostFunction) return await member.call(args);
	}
	throw new TemplaterError(`Unsupported method: ${name}() on ${describe(receiver)}.`);
}
