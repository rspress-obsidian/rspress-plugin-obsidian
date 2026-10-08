import { describe, expect, test } from "bun:test";
import { expandCommands, scanCommands } from "./engine.js";
import { HostFunction, HostObject, type ProgramRuntime } from "./interpreter.js";
import { momentFunction } from "./moment.js";

const NOW = new Date(2024, 4, 1, 9, 30, 15);

/** Expand `source` with the given globals; failures render as `[!message]`. */
async function expand(
	source: string,
	globals: Record<string, unknown> = {},
	keepDynamic = true,
): Promise<{ output: string; errors: Array<{ message: string; command: string }> }> {
	const errors: Array<{ message: string; command: string }> = [];
	const runtime: ProgramRuntime = {
		globals,
		now: NOW,
		onError: (message, command) => {
			errors.push({ message, command });
			return `[!${message}]`;
		},
	};
	const output = await expandCommands(source, runtime, { keepDynamic });
	return { output, errors };
}

async function output(source: string, globals: Record<string, unknown> = {}): Promise<string> {
	return (await expand(source, globals)).output;
}

describe("Templater commands", () => {
	test("text without commands is returned untouched", async () => {
		expect(await output("plain {{title}} text")).toBe("plain {{title}} text");
	});

	test("an output command writes its value in place", async () => {
		expect(await output("a <% 1 + 2 %> b <% 'x' + 1 %> c")).toBe("a 3 b x1 c");
		expect(await output("<% [1, [2, 3], null] %>|<% undefined %>|<% null %>")).toBe(
			"1,2,3,|undefined|null",
		);
		expect(await output("<% ({ a: 1 }) %>")).toBe("[object Object]");
	});

	test("execution commands write through tR, and can reset it", async () => {
		expect(await output('<%* tR += "hello" %> world')).toBe("hello world");
		expect(
			await output(
				'---\ntype: template\n---\nThis is a template.\n\n<%* tR = "" -%>\n---\ntype: person\n---\n# Person',
			),
		).toBe("---\ntype: person\n---\n# Person");
	});

	test("a block opened in one command closes in another", async () => {
		const template = [
			"<%* const items = ['a', 'b'] %>",
			"<%* for (const item of items) { -%>",
			"- <% item.toUpperCase() %>",
			"<%* } -%>",
			"<%* if (items.length > 5) { -%>",
			"many",
			"<%* } else if (items.length > 1) { -%>",
			"some",
			"<%* } else { -%>",
			"one",
			"<%* } -%>",
			"end",
		].join("\n");
		expect(await output(template)).toBe("\n- A\n- B\nsome\nend");
	});

	test("whitespace control trims one newline with - and all whitespace with _", async () => {
		expect(await output("a\n<%- 'b' -%>\nc")).toBe("abc");
		expect(await output("a\n\n<%- 'b' -%>\n\nc")).toBe("a\nb\nc");
		expect(await output("a \r\n<%- 'b' -%>\r\n c")).toBe("a b c");
		expect(await output("a  \n\t<%_ 'b' _%> \n\n c")).toBe("abc");
		expect(await output("a<%* const x = 1 _%>   \n\n")).toBe("a");
		// Without a flag, every newline stays.
		expect(await output("a\n<%* const x = 1 %>\nb")).toBe("a\n\nb");
	});

	test("strings keep their escapes and quotes", async () => {
		expect(await output(`<% "it's \\"quoted\\"" %>|<% 'a\\'b' %>|<% "tab\\tnew\\nline" %>`)).toBe(
			"it's \"quoted\"|a'b|tab\tnew\nline",
		);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a template literal inside a command.
		expect(await output("<% `${1 + 1} and \\`tick\\`` %>|<% '\\u00e9\\x41' %>")).toBe(
			"2 and `tick`|éA",
		);
		// A command ends at the first %>, even inside a string, as in Templater.
		expect((await expand('<% "50%> done" %>')).output).toContain("[!");
	});

	test("variables, assignment, updates, ternaries and operators", async () => {
		expect(
			await output(
				"<%* let n = 1; n += 4; n -= 1; n *= 3; n /= 2; n %= 5; const m = n++ + ++n -%><% n %> <% m %> <% 2 ** 3 ** 2 %> <% 7 % 3 %>",
			),
		).toBe("3 4 512 1");
		expect(
			await output(
				"<% 1 < 2 && 'a' >= 'a' ? 'yes' : 'no' %> <% null ?? 'fallback' %> <% 0 || 'or' %> <% !0 %> <% -'3' %> <% 0 + +'4' %>",
			),
		).toBe("yes fallback or true -3 4");
		expect(
			await output("<% 1 == '1' %> <% 1 === '1' %> <% 1 != 2 %> <% null !== undefined %>"),
		).toBe("true false true true");
		expect(
			await output("<% typeof 'a' %> <% typeof (x => x) %> <% typeof null %> <% typeof [] %>"),
		).toBe("string function object object");
		expect(await output("<% [1] + 1 %> <% 6 / 3 - 1 * 2 %>")).toBe("11 0");
	});

	test("arrow functions, closures, destructuring and await", async () => {
		const template = [
			"<%* const add = (a, b) => a + b",
			"const twice = async x => { const doubled = x * 2; return doubled }",
			"const [first, second] = ['x', 'y'] -%>",
			"<% add(1, 2) %> <% await twice(4) %> <% first + second %> <% (() => {})() %>",
			"<%* for (const [key, value] of Object.entries({ a: 1, b: 2 })) { %><% key %>=<% value %>;<%* } %>",
			"<%* for (const ch of 'hi') { %>[<% ch %>]<%* } %>",
		].join("\n");
		expect(await output(template)).toBe("3 8 xy undefined\na=1;b=2;\n[h][i]");
	});

	test("a top-level return ends the template with its value", async () => {
		expect(await output("before <%* return 'only this' %> after")).toBe("only this");
		expect(await output("kept <%* return %> after")).toBe("kept ");
	});

	test("string methods", async () => {
		const source = [
			"<% ' Ab c '.trim().toLowerCase() %>",
			"<% 'abc'.toUpperCase().slice(1) %>",
			"<% 'a-b-c'.split('-').reverse().join('+') %>",
			"<% 'a1b2'.replace(/\\d/g, '#') %>",
			"<% 'aaa'.replaceAll('a', 'b') %>",
			"<% 'x.y'.replace('.', (m) => '[' + m + ']') %>",
			"<% 'a1b22'.replaceAll(/\\d+/g, (m, i) => m.length) %>",
			"<% 'Hello'.includes('ell') %>/<% 'Hello'.contains('z') %>/<% 'Hello'.startsWith('He') %>/<% 'Hello'.endsWith('lo') %>",
			"<% 'ab'.padStart(4, '0') %>/<% 'ab'.padEnd(3) %>|/<% 'ab'.repeat(2) %>/<% 'abc'.at(-1) %>/<% 'abc'.charAt(1) %>",
			"<% 'abcabc'.indexOf('c') %>/<% 'abcabc'.lastIndexOf('c') %>/<% 'abc'.substring(1, 2) %>/<% 'a'.concat('b', 1) %>",
			"<% 'a2b'.match(/\\d/)[0] %>/<% 'ab'.match(/\\d/) %>/<% 'ab1'.search(/\\d/) %>/<% 'a b'.split(/\\s/).length %>",
			"<% 'b'.localeCompare('a') %>/<% 'x'.length %>/<% 'xy'[1] %>/<% '  a '.trimStart() %>|<% ' a  '.trimEnd() %>|",
		].join("\n");
		expect(await output(source)).toBe(
			[
				"ab c",
				"BC",
				"c+b+a",
				"a#b#",
				"bbb",
				"x[.]y",
				"a1b2",
				"true/false/true/true",
				"00ab/ab |/abab/c/b",
				"2/5/b/ab1",
				"2/null/2/2",
				"1/1/y/a | a|",
			].join("\n"),
		);
	});

	test("array, number, object and JSON helpers", async () => {
		const source = [
			"<% [3, 1, 2].sort() %>|<% [3, 1, 2].sort((a, b) => b - a) %>",
			"<% [1, 2, 3].filter(x => x > 1).map(x => x * 10) %>|<% [1, 2, 3].reduce((a, b) => a + b, 0) %>|<% [1, 2, 3].reduce((a, b) => a * b) %>",
			"<% [1, 2].find(x => x > 1) %>|<% [1, 2].findIndex(x => x > 5) %>|<% [1, 2].some(x => x > 1) %>|<% [1, 2].every(x => x > 1) %>",
			"<% [1, 2].includes(2) %>|<% ['a'].contains('b') %>|<% [1, 2].indexOf(2) %>|<% [1, [2, [3]]].flat() %>|<% [1, 1, 2].unique() %>",
			"<% [1, 2, 3].slice(1).concat(4, [5]) %>|<% [1, 2].first() %>|<% [1, 2].last() %>|<% [1, 2].at(-1) %>|<% [1, 2].length %>",
			"<%* const list = [1]; list.push(2, 3); list.unshift(0); list.pop(); list.shift(); list.forEach(x => x) %><% list %>",
			"<% (3.14159).toFixed(2) %>|<% (255).toString(16) %>|<% (1234.5).toPrecision(2) %>|<% true.toString() %>",
			"<% Math.round(2.5) %>|<% Math.floor(-1.5) %>|<% Math.min(3, 1) %>|<% Math.PI > 3 %>|<% Math.abs(-2) %>",
			"<% Object.keys({ a: 1, b: 2 }) %>|<% Object.values({ a: 1 }) %>|<% Object.fromEntries([['k', 'v']]).k %>",
			"<% JSON.stringify({ a: [1, 'x'], f: x => x }) %>|<% JSON.parse('{\"n\": 2}').n %>|<% JSON.stringify([1], null, 1) %>",
			"<% String(12) + Number('3') %>|<% Boolean('') %>|<% parseInt('42px') %>|<% parseFloat('1.5') %>|<% isNaN('x') %>|<% Array.isArray([]) %>",
		].join("\n");
		expect(await output(source)).toBe(
			[
				"1,2,3|3,2,1",
				"20,30|6|6",
				"2|-1|true|false",
				"true|false|1|1,2,3|1,2",
				"2,3,4,5|1|2|2|2",
				"1,2",
				"3.14|ff|1.2e+3|true",
				"3|-2|1|true|2",
				"a,b|1|v",
				'{"a":[1,"x"]}|2|[\n 1\n]',
				"123|false|42|1.5|true|true",
			].join("\n"),
		);
	});

	test("dates read the template's clock", async () => {
		expect(
			await output(
				"<% new Date().getFullYear() %>-<% new Date().getMonth() + 1 %>-<% new Date().getDate() %> <% Date.now() === new Date().getTime() %> <% new Date(2020, 0, 2).getDay() %>",
			),
		).toBe("2024-5-1 true 4");
		expect(await output("<% new Date('2020-01-02T03:04:05Z').toISOString() %>")).toBe(
			"2020-01-02T03:04:05.000Z",
		);
		expect(await output("<% new Date(0).getTime() + new Date(new Date(5)).getTime() %>")).toBe("5");
		expect(
			await output("<% new Date() > new Date(2000, 0, 1) %> <% new Date() - new Date() %>"),
		).toBe("true 0");
	});

	test("the moment global formats, parses and shifts", async () => {
		const globals = { moment: momentFunction(NOW) };
		const source = [
			"<% moment().format('YYYY-MM-DD HH:mm') %>",
			"<% moment('2024-01-31', 'YYYY-MM-DD').add(1, 'month').format('YYYY-MM-DD') %>",
			"<% moment('2024-05-15', 'YYYY-MM-DD').startOf('month').format('YYYY-MM-DD') %>",
			"<% moment('2024-05-15', 'YYYY-MM-DD').endOf('month').format('YYYY-MM-DD HH:mm') %>",
			"<% moment('2024-05-15').subtract(1, 'w').format('ddd D MMM') %>",
			"<% moment('2024-05-15').add('P1D').weekday(0).format('YYYY-MM-DD') %>",
			"<% moment('2024-05-15').isoWeekday(1).format('YYYY-MM-DD') %>/<% moment('2024-05-15').day() %>",
			"<% moment('nonsense', 'YYYY-MM-DD').isValid() %>/<% moment('nope', 'YYYY').format() %>",
			"<% moment('2024-05-10').isBefore(moment('2024-05-11')) %>/<% moment('2024-05-10').isSame('2024-05-10T12:00', 'day') %>",
			"<% moment('2024-06-01').diff(moment('2024-05-01'), 'days') %>/<% moment('2025-03-01').diff('2024-05-01', 'months') %>",
			"<% moment('2024-05-15 13:45', ['DD/MM/YYYY', 'YYYY-MM-DD HH:mm']).hour() %>",
		].join("\n");
		expect((await expand(source, globals)).output).toBe(
			[
				"2024-05-01 09:30",
				"2024-02-29",
				"2024-05-01",
				"2024-05-31 23:59",
				"Wed 8 May",
				"2024-05-12",
				"2024-05-13/3",
				"false/Invalid date",
				"true/true",
				"31/10",
				"13",
			].join("\n"),
		);
	});

	test("moments print, compare and expose their methods like moment.js", async () => {
		const globals = { moment: momentFunction(NOW) };
		const source = [
			"<% moment('2024-05-15T10:00:00') %>",
			"<% moment('2024-05-16') > moment('2024-05-15') %>/<% moment('x', 'YYYY') > 0 %>",
			"<% typeof moment().format %>/<% moment().nope %>",
			"<% moment('2024-05-15T10:20:30').unix() === moment('2024-05-15T10:20:30').valueOf() / 1000 %>",
			"<% moment('2024-05-15').toDate().getDate() %>/<% moment('2024-05-15T00:00:00Z').toISOString() %>",
			"<%* const m = moment('2024-05-15'); const c = m.clone(); c.add(1, 'd') %><% m.date() %>/<% c.date() %>/<% moment(m).date() %>/<% moment(new Date(2020, 0, 1)).year() %>/<% moment(0).valueOf() %>",
			"<% moment('2024-05-15T10:20:30').month() %>/<% moment('2024-05-15').year(2020).format('YYYY') %>/<% moment('2024-05-15T10:20:30').minute() %>/<% moment('2024-05-15T10:20:30').second() %>",
			"<% moment('2024-05-15').date(1).month(0).hour(5).minute(6).second(7).format('YYYY-MM-DD HH:mm:ss') %>",
			"<% moment('2024-05-15').isAfter('2024-05-14') %>/<% moment('2024-05-15').isSameOrBefore('2024-05-15') %>/<% moment('2024-05-15').isSameOrAfter('2024-05-16') %>",
			"<% moment('2024-05-15').isBefore() %>/<% moment('2024-05-15').diff('2023-05-15', 'years') %>/<% moment('2024-05-15').diff('2024-01-15', 'Q') %>/<% moment('2024-05-15T02:00').diff('2024-05-15T00:00', 'hours') %>",
			"<% moment('2024-05-15').add('days', 2).format('D') %>/<% moment('2024-05-15').add(90, 'm').format('HH:mm') %>/<% moment('2024-05-15').subtract('1.02:00:00').format('D HH') %>",
			"<% moment('2024-05-15').startOf('year').format('MM-DD') %>/<% moment('2024-05-15').startOf('quarter').format('MM-DD') %>/<% moment('2024-05-15').startOf('isoWeek').format('MM-DD') %>/<% moment('2024-05-15').endOf('week').format('MM-DD HH:mm') %>",
			"<% moment('2024-05-15T10:20:30').startOf('hour').format('HH:mm:ss') %>/<% moment('2024-05-15T10:20:30').startOf('minute').format('mm:ss') %>/<% moment('2024-05-15T10:20:30.5').startOf('second').format('ss.SSS') %>",
			"<% moment('2024-05-15T10:00:00+02:00').toISOString() %>/<% moment('2024-05-15T10:00:00Z').unix() %>/<% moment('May 15, 2024').date() %>",
			"<% moment('bad').add(1, 'd').isValid() %>/<% moment('bad').date() %>/<% moment('bad').date(3).isValid() %>/<% moment('bad').startOf('day').isValid() %>/<% moment('bad').toISOString() %>/<% moment('bad').unix() %>/<% moment('bad').diff() %>/<% moment('bad').isBefore() %>/<% moment('bad').toDate().getTime() %>",
			"<% moment('2024-05-15').toString() === String(moment('2024-05-15')) %>",
		].join("\n");
		const result = await expand(source, globals);
		expect(result.output.split("\n")).toEqual([
			expect.stringMatching(/^Wed May 15 2024 10:00:00 GMT[+-]\d{4}$/),
			"true/false",
			"function/undefined",
			"true",
			"15/2024-05-15T00:00:00.000Z",
			"15/16/15/2020/0",
			"4/2020/20/30",
			"2024-01-01 05:06:07",
			"true/true/false",
			"false/1/1/2",
			"17/01:30/13 22",
			"01-01/04-01/05-13/05-18 23:59",
			"10:00:00/20:00/30.000",
			"2024-05-15T08:00:00.000Z/1715767200/15",
			"false/NaN/false/false/null/NaN/NaN/false/NaN",
			"true",
		]);
		const unknown = await expand(
			"<% moment().add(1, 'fortnight') %><% moment().startOf('eon') %><% moment().fly() %>",
			globals,
		);
		expect(unknown.errors.map((error) => error.message)).toEqual([
			'Unknown moment unit "fortnight".',
			'Unknown moment unit "eon".',
			"Unsupported method: fly() on a moment.",
		]);
	});

	test("optional calls, odd callees and the console", async () => {
		const globals = { tp: new HostObject("tp", { a: 1, b: new HostFunction("tp.b", () => 2) }) };
		expect(
			await output(
				"<% ' x '.trim?.() %>|<% ({}).f?.() %>|<% tp.c?.() %>|<% tp.b?.() %>|<% Object.keys(tp) %>|<% tp %>|<% tp > 1 %>|<% Object.entries([5]) %>|<%* console.log('hidden') %>",
				globals,
			),
		).toBe("x|undefined|undefined|2|a,b|[object Object]|false|0,5|");
		expect((await expand("<% (1)() %>")).errors[0]?.message).toBe(
			"The expression is not a function.",
		);
		expect((await expand("<% Object.keys(5) %>")).errors[0]?.message).toBe(
			"Expected an object, got a number.",
		);
		expect((await expand("<% Object.fromEntries(5) %>")).errors[0]?.message).toBe(
			"Object.fromEntries() needs an array.",
		);
		expect((await expand("<% 'a'.replaceAll(/a/, 'b') %>")).errors[0]?.message).toBe(
			"replaceAll() needs a global regex.",
		);
		expect(
			await output(
				"<% /a/g.test('cat') %>|<% /a/.source %>|<% /a/gi.flags %>|<% /x/ %>|<% /x/.toString() %>|<% /x/.nope %>",
			),
		).toBe("true|a|gi|/x/|/x/|undefined");
	});

	test("host objects expose their table and nothing else", async () => {
		const globals = {
			tp: new HostObject("tp", {
				greet: new HostFunction("tp.greet", ([name]) => `hi ${String(name)}`),
				data: { "key with space": 1, nested: { deep: true } },
				later: new HostFunction("tp.later", async () => "awaited"),
			}),
		};
		expect(
			await output(
				"<% tp.greet('you') %> <% tp.data['key with space'] %> <% tp.data.nested.deep %> <% await tp.later() %> <% tp.missing %> <% tp.data?.none?.deeper %>",
				globals,
			),
		).toBe("hi you 1 true awaited undefined undefined");
		const failed = await expand("<% tp.nope() %>", globals);
		expect(failed.errors[0]?.message).toBe("tp.nope is not a function.");
	});

	test("a failing command leaves a marker and the rest still renders", async () => {
		const result = await expand("a <% missing %> b <%* undefinedFn() %> c <% (1).nope() %>");
		expect(result.output).toBe(
			'a [!"missing" is not defined.] b [!"undefinedFn" is not defined.] c [!Unsupported method: nope() on a number.]',
		);
		expect(result.errors.map((error) => error.command)).toEqual([
			"<% missing %>",
			"<%* undefinedFn() %>",
			"<% (1).nope() %>",
		]);
		// An output command's syntax error is its own; the template goes on.
		expect((await expand("<% 1 + %> ok")).output).toBe(
			"[!Unsupported syntax: the end of the template in `<% 1 + %>`.] ok",
		);
	});

	test("statements that do not parse abort the template with one marker", async () => {
		const unclosedBlock = await expand("<%* if (true) { %> body");
		expect(unclosedBlock.output).toBe(
			'[!Unsupported syntax: the end of the template (expected "}").]',
		);
		expect((await expand("text <% never closed")).output).toBe(
			"[!A command on line 1 has no closing `%>`.]",
		);
		expect((await expand("<%* const = 1 %>")).output).toContain("expected a name");
		expect((await expand("<%* const x %>")).output).toContain("a declaration needs a value");
	});

	test("unsupported JavaScript is named, never run", async () => {
		const cases: Record<string, string> = {
			"<%* while (true) {} %>": '"while" is not supported here',
			"<%* function f() {} %>": '"function" is not supported here',
			"<% new Map() %>": "only `new Date(…)` is supported",
			"<% 1 | 2 %>": "the | operator is not supported",
			"<% [...[1]] %>": "spread is not supported",
			"<% Math.max(...[1]) %>": "spread arguments are not supported",
			"<%* for (let i = 0; i < 3; i++) {} %>": "only for (… of …) loops are supported",
			"<% Math.random() %>": "Math.random() is not available",
			"<% 'a'.big() %>": "Unsupported method: big() on a string.",
			"<% [].nope() %>": "Unsupported method: nope() on an array.",
			"<% new Date().setTime(1) %>": "Unsupported method: setTime() on a date.",
			"<%* const c = 1; c = 2 %>": 'Cannot assign to the constant "c".',
			"<%* undeclared = 2 %>": '"undeclared" is not declared.',
			"<%* let d = 1; let d = 2 %>": '"d" is already declared.',
			"<% /(/ %>": "Invalid regular expression",
			"<% 'unterminated %>": "Unterminated string.",
			"<% x # y %>": 'Unexpected character "#".',
			"<% null.x %>": 'Cannot read "x" of null.',
			"<%* for (const x of 5) {} %>": "for (… of …) needs an array.",
			"<%* const [a] = 5 %>": "Only an array can be destructured.",
			"<% [].reduce((a, b) => a) %>": "reduce() of an empty array needs a start value.",
			"<% 'x'.match('x') %>": "match() needs a regular expression.",
			"<% JSON.parse('{') %>": "JSON.parse:",
			"<% [1].map(5) %>": "Expected a function, got a number.",
			"<% ({})[{}] %>": "An index must be a string or a number.",
		};
		for (const [source, message] of Object.entries(cases)) {
			const result = await expand(source);
			expect(result.errors.length, source).toBeGreaterThan(0);
			expect(result.output, source).toContain(message);
		}
	});

	test("host and prototype access is rejected", async () => {
		const forbidden = [
			"<% constructor %>",
			"<% 'a'.constructor %>",
			"<% 'a'['constructor'] %>",
			"<% ({}).__proto__ %>",
			"<% ({})['__proto__'] %>",
			"<% [].prototype %>",
			"<% Object.fromEntries([['__proto__', 1]]) %>",
			"<% ({ constructor: 1 }) %>",
			"<% globalThis %>",
			"<% process.env.HOME %>",
			"<% require('fs') %>",
			"<% import('fs') %>",
			"<% Function('return 1')() %>",
			"<% eval('1') %>",
			"<% app.vault %>",
			"<%* (() => fetch('https://example.com'))() %>",
			"<% 'a'.toString.constructor %>",
			"<% [].map.call %>",
		];
		for (const source of forbidden) {
			const result = await expand(source);
			expect(result.errors.length, source).toBe(1);
			expect(result.output, source).toMatch(/^\[!/);
		}
		const hostApi = await expand("<% app %>");
		expect(hostApi.errors[0]?.message).toBe(
			"The Obsidian `app` object does not exist on a static site.",
		);
	});

	test("a runaway program is stopped", async () => {
		const recursion = await expand("<%* const f = n => f(n + 1) %><% f(0) %>");
		expect(recursion.output).toBe("[!Too much recursion.]");
		const steps = await expand(
			"<%* const big = 'x'.repeat(2000).split('') %><%* for (const a of big) { for (const b of big) { } } %>",
		);
		expect(steps.output).toContain("steps and was stopped");
		// A loop over an array it grows still ends: it iterates a snapshot.
		expect(
			await output(
				"<%* const xs = [1, 2] %><%* for (const x of xs) { xs.push(x) } %><% xs.length %>",
			),
		).toBe("4");
	});

	test("comments and automatic semicolons", async () => {
		expect(
			await output(
				"<%* // a comment\nconst a = 1 /* block\ncomment */\nconst b = 2\n%><% a + b %>",
			),
		).toBe("3");
		expect((await expand("<%* /* never closed %>")).output).toContain("Unterminated comment.");
		expect((await expand("<%* const a = 1 const b = 2 %>")).output).toContain(
			"expected the end of the statement",
		);
	});

	test("dynamic commands are kept for the reading view, or run when asked", async () => {
		expect(await output("Updated <%+ tp.missing %> by <% 'x' %>")).toBe(
			"Updated <%+ tp.missing %> by x",
		);
		expect((await expand("<%+ 1 + 1 %>|<%*+ tR += 'e' %>", {}, false)).output).toBe("2|e");
	});
});

describe("escape vectors", () => {
	test("prototype names are refused however the key is built", async () => {
		for (const source of [
			"<% 'a'['con' + 'structor'] %>",
			"<% 'a'[`__proto__`] %>",
			"<% [][['proto', 'type'].join('')] %>",
			"<% ({})['__defineGetter__'] %>",
			"<% ({})['__lookupGetter__']('x') %>",
			"<% 'a'['toString']['con' + 'structor'] %>",
		]) {
			const result = await expand(source);
			expect(result.errors.length, source).toBe(1);
			expect(result.output, source).toMatch(/is not available to templates|Cannot read/);
		}
		expect((await expand("<% ({ ['__proto__']: 1 }) %>")).output).toContain(
			"expected an object key",
		);
	});

	test("a host function exposes nothing but its call", async () => {
		expect(await output("<% typeof Math.max.call %>|<% typeof Math.max.apply %>")).toBe(
			"undefined|undefined",
		);
		expect((await expand("<% Math.max.call(null, 1, 2) %>")).output).toContain(
			"Unsupported method: call() on an object.",
		);
		expect(
			await output("<% typeof tp.file.include.bind %>", {
				tp: new HostObject("tp", {
					file: new HostObject("tp.file", { include: new HostFunction("include", () => "") }),
				}),
			}),
		).toBe("undefined");
	});

	test("Symbol, Reflect and Proxy do not exist", async () => {
		expect((await expand("<% Symbol.iterator %>")).output).toBe('[!"Symbol" is not defined.]');
		expect((await expand("<% Reflect.ownKeys(tp) %>")).output).toContain(
			"`Reflect` is not available",
		);
		expect((await expand("<% Proxy %>")).output).toContain("`Proxy` is not available");
	});

	test("coercing an object never calls its toString or valueOf", async () => {
		const source =
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a template literal inside a command.
			"<% '' + { toString: () => 'called' } %>|<% `${{ toString: () => 'called' }}` %>|<% [{ toString: () => 'called' }].join() %>|<% Number({ valueOf: () => 7 }) %>|<% { valueOf: () => 7 } > 6 %>";
		expect(await output(source)).toBe("[object Object]|[object Object]|[object Object]|NaN|false");
		expect(await output("<% String(new Date({ valueOf: () => 0 })) %>")).toBe("Invalid Date");
	});

	test("JSON.parse cannot pollute a prototype or smuggle a forbidden key", async () => {
		const source =
			'<%* const o = JSON.parse(\'{"__proto__": {"polluted": 1}}\') %><% ({}).polluted %>|<% Object.keys(o) %>|<% JSON.stringify(o) %>';
		expect(await output(source)).toBe('undefined|__proto__|{"__proto__":{"polluted":1}}');
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(
			(await expand("<% Object.fromEntries(Object.entries(JSON.parse('{\"__proto__\": 1}'))) %>"))
				.output,
		).toContain("`__proto__` is not available to templates.");
	});

	test("a host object cannot be reassigned or extended", async () => {
		expect((await expand("<%* Math.PI = 3 %>")).output).toContain("Unsupported syntax");
		expect((await expand("<%* Math = 3 %>")).output).toContain('"Math" is not declared.');
		expect(await output("<% Math.PI %>")).toBe(String(Math.PI));
	});
});

describe("denial of service", () => {
	test("huge strings are refused with a clear error", async () => {
		const cases: Record<string, string> = {
			"<% 'x'.repeat(1e9) %>":
				"A text value would be 1000000000 characters long, over the limit of 10000000",
			"<% 'x'.padStart(1e9) %>": "A text value would be 1000000000 characters long",
			"<% 'x'.padEnd(1e9, 'ab') %>": "A text value would be 1000000000 characters long",
			"<%* const s = 'x'.repeat(6e6) %><% s + s %>": "A text value would be 12000000",
			"<%* const s = 'x'.repeat(6e6) %><% `${s}${s}` %>": "A text value would be",
			"<%* const s = 'x'.repeat(4e6) %><% 'x'.concat(s, s, s) %>": "A text value would be",
			"<%* const s = 'x'.repeat(4e6) %><% [s, s, s].join('') %>": "A text value would be",
			"<%* const s = 'x'.repeat(4e6) %><% [s, s, s] %>": "A text value would be",
			"<% 'a'.repeat(1e5).replace(/a/g, 'b'.repeat(1000)) %>": "A text value would be",
			"<% 'a'.repeat(1e5).replaceAll('a', '$&'.repeat(200)) %>": "A text value would be",
			"<% 'x'.repeat(2e4).replace(/x/g, () => 'y'.repeat(1000)) %>": "A text value would be",
			"<%* const s = 'x'.repeat(6e6) %><%* tR += s %><%* tR += s %>": "A text value would be",
		};
		for (const [source, message] of Object.entries(cases)) {
			const result = await expand(source);
			expect(result.errors.length, source).toBeGreaterThan(0);
			expect(result.output, source).toContain(message);
		}
		// Below the limits, the counts are JavaScript's, not clamped.
		expect(await output("<% 'ab'.repeat(200000).length %>|<% 'x'.padStart(150000).length %>")).toBe(
			"400000|150000",
		);
	});

	test("huge lists are refused with a clear error", async () => {
		const square = `const x = 'x'.repeat(1001).split(''); const y = [${Array(1001).fill("x").join(", ")}]`;
		const cases: Record<string, string> = {
			"<% 'x'.repeat(2e6).split('') %>":
				"A list would have 2000000 items, over the limit of 1000000",
			"<%* const x = 'x'.repeat(6e5).split('') %><% x.concat(x).length %>":
				"A list would have 1200000 items",
			[`<%* ${square} %><% y.flat().length %>`]: "A list would have",
			[`<%* ${square} %><% JSON.stringify(y) %>`]: "A list would have",
		};
		for (const [source, message] of Object.entries(cases)) {
			const result = await expand(source);
			expect(result.errors.length, source).toBeGreaterThan(0);
			expect(result.output, source).toContain(message);
		}
	});

	test("building the same long list over and over runs out of steps", async () => {
		const result = await expand(
			"<%* const x = 'x'.repeat(1000).split(''); const y = x.map(() => x); const z = y.map(() => y) %>",
		);
		expect(result.output).toBe("[!The template ran more than 1000000 steps and was stopped.]");
	});

	test("unique() is linear, and keeps JavaScript's === semantics", async () => {
		expect(await output("<% [1, '1', 1, 0 / 0, 0 / 0, 0, -0].unique().length %>")).toBe("4");
		expect(await output("<% 'abcdefghij'.repeat(30000).split('').unique().join('') %>")).toBe(
			"abcdefghij",
		);
	});

	test("an unsafe regex literal is refused before it runs", async () => {
		const inline = await expand("<% /(a+)+$/.test('aaaa') %>");
		expect(inline.output).toBe(
			"[!Regular expression /(a+)+$/ uses nested quantifiers (possible catastrophic backtracking detected); Obsidian would run it, but a site build refuses it so the build cannot hang.]",
		);
		// In an execution command it aborts the template, as any syntax error does.
		const block = await expand("before <%* const r = /(\\w+\\s?)*$/ %> after");
		expect(block.output).toContain("uses nested quantifiers");
		expect(block.output).not.toContain("after");
		expect(await output("<% /(ab)+$/.test('abab') %>")).toBe("true");
	});

	test("a stack overflow is reported in place, not thrown", async () => {
		const deep = `${"(".repeat(20000)}1${")".repeat(20000)}`;
		const message =
			"The expression is nested too deeply or recurses too far to evaluate (the interpreter ran out of stack).";
		expect((await expand(`<% ${deep} %>`)).output).toBe(`[!${message}]`);
		expect((await expand(`<%* const a = ${deep} %>`)).output).toBe(`[!${message}]`);
		const cyclic = await expand("<%* const a = []; a.push(a) %><% a %>|<% JSON.stringify(a) %>");
		expect(cyclic.output).toBe(`[!${message}]|[!${message}]`);
	});
});

describe("scanCommands", () => {
	test("reads the command type, the dynamic marker and the whitespace flags", () => {
		const { commands } = scanCommands("<%_* a -%> <%+ b %> <%-*+ c _%> <% d %>");
		expect(
			commands.map(({ kind, dynamic, code, open, close }) => ({
				kind,
				dynamic,
				code,
				open,
				close,
			})),
		).toEqual([
			{ kind: "exec", dynamic: false, code: " a ", open: "all", close: "single" },
			{ kind: "output", dynamic: true, code: " b ", open: undefined, close: undefined },
			{ kind: "exec", dynamic: true, code: " c ", open: "single", close: "all" },
			{ kind: "output", dynamic: false, code: " d ", open: undefined, close: undefined },
		]);
		expect(scanCommands("a <% b").unclosed).toBe(2);
	});
});
