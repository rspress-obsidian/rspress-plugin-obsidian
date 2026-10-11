/**
 * Test-side renderer for the element the remark pass emits for a formula.
 *
 * In a real build a page's formula reaches the MDX compiler as
 * `<span className="obsidian-math" dangerouslySetInnerHTML={{ __html: "…" }} />`,
 * with the markup held in the attribute's ESTree. Tests that compile a page with
 * plain `remark-rehype` or `remark-stringify` have no MDX runtime, so these
 * handlers write the element out as HTML and the assertions keep reading the
 * page's real markup. Any other MDX node is refused, as those compilers refuse
 * it without them.
 */
import type { Options as RemarkRehypeOptions } from "remark-rehype";

interface JsxAttribute {
	name?: string;
	value?: unknown;
}

interface JsxNode {
	type: string;
	name?: string | null;
	attributes?: JsxAttribute[];
}

interface ExpressionValue {
	data?: {
		estree?: {
			body?: Array<{ expression?: { properties?: Array<{ value?: { value?: unknown } }> } }>;
		};
	};
}

/** The HTML the formula element renders to, or `undefined` for any other node. */
export function mathElementHtml(node: JsxNode): string | undefined {
	const inner = node.attributes?.find((entry) => entry.name === "dangerouslySetInnerHTML");
	const markup = (inner?.value as ExpressionValue | undefined)?.data?.estree?.body?.[0]?.expression
		?.properties?.[0]?.value?.value;
	if (typeof markup !== "string") return undefined;
	const className = node.attributes?.find((entry) => entry.name === "className")?.value;
	return `<${node.name} class="${className}">${markup}</${node.name}>`;
}

function refuse(node: JsxNode): never {
	throw new Error(`Cannot handle unknown node \`${node.type}\``);
}

/**
 * `remark-rehype` `handlers`: the formula as raw HTML, through the library's own
 * `html` handler, so it is kept or dropped as `allowDangerousHtml` says.
 */
export const toHastMathHandlers: NonNullable<RemarkRehypeOptions["handlers"]> = {
	mdxJsxFlowElement: (state, node: JsxNode) => {
		const html = mathElementHtml(node);
		return html === undefined
			? refuse(node)
			: state.handlers.html?.(state, { type: "html", value: html }, undefined);
	},
	mdxJsxTextElement: (state, node: JsxNode) => {
		const html = mathElementHtml(node);
		return html === undefined
			? refuse(node)
			: state.handlers.html?.(state, { type: "html", value: html }, undefined);
	},
};

/** `remark-stringify` `handlers`: the formula as the HTML a markdown file would hold. */
export const toMarkdownMathHandlers = {
	mdxJsxFlowElement: (node: JsxNode) => mathElementHtml(node) ?? refuse(node),
	mdxJsxTextElement: (node: JsxNode) => mathElementHtml(node) ?? refuse(node),
};
