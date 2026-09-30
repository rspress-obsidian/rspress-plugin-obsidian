// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { expect, spyOn, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { navigation, useNavigateTo, usePathname } from "./usePathname.js";

function Probe() {
	const pathname = usePathname();
	const go = useNavigateTo();
	return (
		<button type="button" onClick={() => go("/api")}>
			{pathname}
		</button>
	);
}

test("follows a client-side route change inside the router", async () => {
	history.replaceState({}, "", "/guide");
	const assign = spyOn(navigation, "assign").mockImplementation(() => {});
	const { container } = render(
		<MemoryRouter initialEntries={["/guide"]}>
			<Probe />
		</MemoryRouter>,
	);

	expect(container.textContent).toBe("/guide");

	await act(async () => {
		(container.querySelector("button") as HTMLButtonElement).click();
	});

	// The graph followed the route without a document load — reading
	// `window.location` on its own never saw anything but `/guide`.
	expect(container.textContent).toBe("/api");
	expect(assign).not.toHaveBeenCalled();

	assign.mockRestore();
	cleanup();
});

test("falls back to the document path outside a router", async () => {
	history.replaceState({}, "", "/guide");
	const { container } = render(<Probe />);

	expect(container.textContent).toBe("/guide");

	// The only route change a document without a router can report.
	history.replaceState({}, "", "/api");
	await act(async () => {
		window.dispatchEvent(new PopStateEvent("popstate"));
	});
	expect(container.textContent).toBe("/api");

	cleanup();
});
