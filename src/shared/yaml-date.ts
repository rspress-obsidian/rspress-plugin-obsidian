/**
 * A YAML timestamp read the way Obsidian reads it.
 *
 * gray-matter's YAML parses `2024-05-01` and `2024-05-01 10:00:00` as UTC
 * instants. Obsidian reads both as local wall-clock values, so a property
 * dated `2024-05-01` shows that day wherever the site is built, not April 30
 * west of Greenwich. Every reader of a frontmatter `Date` goes through this.
 */
import { localDate } from "./date-math.js";

export function yamlDateAsLocal(value: Date): Date | undefined {
	if (Number.isNaN(value.getTime())) return undefined;
	return localDate(
		value.getUTCFullYear(),
		value.getUTCMonth(),
		value.getUTCDate(),
		value.getUTCHours(),
		value.getUTCMinutes(),
		value.getUTCSeconds(),
		value.getUTCMilliseconds(),
	);
}
