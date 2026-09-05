import type { CanvasData, CanvasEdgeData, CanvasNode } from './types';

export class CanvasParseError extends Error {
  constructor(message: string) {
    super(`Canvas parse error: ${message}`);
    this.name = 'CanvasParseError';
  }
}

const VALID_NODE_TYPES = ['text', 'file', 'link', 'group'] as const;
const VALID_SIDES = ['top', 'right', 'bottom', 'left'] as const;
const VALID_EDGE_ENDS = ['none', 'arrow'] as const;
const VALID_BACKGROUND_STYLES = ['cover', 'ratio', 'repeat'] as const;

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new CanvasParseError(`Expected ${field} to be a string, got ${typeof value}`);
  }
  return value;
}

function assertNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CanvasParseError(`Expected ${field} to be a finite number, got ${typeof value}`);
  }
  return value;
}

function assertOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return assertString(value, field);
}

function validateNode(node: unknown): CanvasNode {
  if (typeof node !== 'object' || node === null) {
    throw new CanvasParseError('Node must be an object');
  }

  const n = node as Record<string, unknown>;

  const id = assertString(n.id, 'node.id');
  const type = assertString(n.type, 'node.type');
  const x = assertNumber(n.x, 'node.x');
  const y = assertNumber(n.y, 'node.y');
  const width = assertNumber(n.width, 'node.width');
  const height = assertNumber(n.height, 'node.height');
  const color = assertOptionalString(n.color, 'node.color');

  if (!VALID_NODE_TYPES.includes(type as (typeof VALID_NODE_TYPES)[number])) {
    throw new CanvasParseError(`Invalid node type: ${type}`);
  }

  const base = { id, type, x, y, width, height, color };

  switch (type) {
    case 'text': {
      const text = assertString(n.text, 'node.text');
      return { ...base, type: 'text', text };
    }
    case 'file': {
      const file = assertString(n.file, 'node.file');
      const subpath = assertOptionalString(n.subpath, 'node.subpath');
      const fileContent = assertOptionalString(n.fileContent, 'node.fileContent');
      const assetUrl = assertOptionalString(n.assetUrl, 'node.assetUrl');
      const imageUrl = assertOptionalString(n.imageUrl, 'node.imageUrl');
      const mediaType = assertOptionalString(n.mediaType, 'node.mediaType');
      const isImage =
        n.isImage === undefined
          ? undefined
          : typeof n.isImage === 'boolean'
            ? n.isImage
            : (() => {
                throw new CanvasParseError('Expected node.isImage to be a boolean');
              })();
      const isVideo =
        n.isVideo === undefined
          ? undefined
          : typeof n.isVideo === 'boolean'
            ? n.isVideo
            : (() => {
                throw new CanvasParseError('Expected node.isVideo to be a boolean');
              })();
      const isAudio =
        n.isAudio === undefined
          ? undefined
          : typeof n.isAudio === 'boolean'
            ? n.isAudio
            : (() => {
                throw new CanvasParseError('Expected node.isAudio to be a boolean');
              })();
      const isPdf =
        n.isPdf === undefined
          ? undefined
          : typeof n.isPdf === 'boolean'
            ? n.isPdf
            : (() => {
                throw new CanvasParseError('Expected node.isPdf to be a boolean');
              })();
      const isError =
        n.isError === undefined
          ? undefined
          : typeof n.isError === 'boolean'
            ? n.isError
            : (() => {
                throw new CanvasParseError('Expected node.isError to be a boolean');
              })();
      return {
        ...base,
        type: 'file',
        file,
        subpath,
        fileContent,
        assetUrl,
        imageUrl,
        mediaType,
        isImage,
        isVideo,
        isAudio,
        isPdf,
        isError,
      };
    }
    case 'link': {
      const url = assertString(n.url, 'node.url');
      return { ...base, type: 'link', url };
    }
    case 'group': {
      const label = assertOptionalString(n.label, 'node.label');
      const background = assertOptionalString(n.background, 'node.background');
      const backgroundUrl = assertOptionalString(n.backgroundUrl, 'node.backgroundUrl');
      const backgroundStyle = assertOptionalString(n.backgroundStyle, 'node.backgroundStyle');
      if (
        backgroundStyle &&
        !VALID_BACKGROUND_STYLES.includes(
          backgroundStyle as (typeof VALID_BACKGROUND_STYLES)[number],
        )
      ) {
        throw new CanvasParseError(`Invalid backgroundStyle: ${backgroundStyle}`);
      }
      return {
        ...base,
        type: 'group',
        label,
        background,
        backgroundUrl,
        backgroundStyle: backgroundStyle as 'cover' | 'ratio' | 'repeat' | undefined,
      };
    }
    default:
      throw new CanvasParseError(`Unhandled node type: ${type}`);
  }
}

function validateEdge(edge: unknown): CanvasEdgeData {
  if (typeof edge !== 'object' || edge === null) {
    throw new CanvasParseError('Edge must be an object');
  }

  const e = edge as Record<string, unknown>;

  const id = assertString(e.id, 'edge.id');
  const fromNode = assertString(e.fromNode, 'edge.fromNode');
  const toNode = assertString(e.toNode, 'edge.toNode');

  const fromSide = assertOptionalString(e.fromSide, 'edge.fromSide');
  if (fromSide && !VALID_SIDES.includes(fromSide as (typeof VALID_SIDES)[number])) {
    throw new CanvasParseError(`Invalid fromSide: ${fromSide}`);
  }

  const toSide = assertOptionalString(e.toSide, 'edge.toSide');
  if (toSide && !VALID_SIDES.includes(toSide as (typeof VALID_SIDES)[number])) {
    throw new CanvasParseError(`Invalid toSide: ${toSide}`);
  }

  const fromEnd = assertOptionalString(e.fromEnd, 'edge.fromEnd');
  if (fromEnd && !VALID_EDGE_ENDS.includes(fromEnd as (typeof VALID_EDGE_ENDS)[number])) {
    throw new CanvasParseError(`Invalid fromEnd: ${fromEnd}`);
  }

  const toEnd = assertOptionalString(e.toEnd, 'edge.toEnd');
  if (toEnd && !VALID_EDGE_ENDS.includes(toEnd as (typeof VALID_EDGE_ENDS)[number])) {
    throw new CanvasParseError(`Invalid toEnd: ${toEnd}`);
  }

  const color = assertOptionalString(e.color, 'edge.color');
  const label = assertOptionalString(e.label, 'edge.label');

  return {
    id,
    fromNode,
    fromSide: fromSide as CanvasEdgeData['fromSide'],
    fromEnd: fromEnd as CanvasEdgeData['fromEnd'],
    toNode,
    toSide: toSide as CanvasEdgeData['toSide'],
    toEnd: toEnd as CanvasEdgeData['toEnd'],
    color,
    label,
  };
}

export function parseCanvas(json: string): CanvasData {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new CanvasParseError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new CanvasParseError('Canvas data must be an object');
  }

  const d = data as Record<string, unknown>;

  const nodes: CanvasNode[] = [];
  if (d.nodes !== undefined) {
    if (!Array.isArray(d.nodes)) {
      throw new CanvasParseError('nodes must be an array');
    }
    for (const node of d.nodes) {
      nodes.push(validateNode(node));
    }
  }

  const edges: CanvasEdgeData[] = [];
  if (d.edges !== undefined) {
    if (!Array.isArray(d.edges)) {
      throw new CanvasParseError('edges must be an array');
    }
    for (const edge of d.edges) {
      edges.push(validateEdge(edge));
    }
  }

  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) {
      throw new CanvasParseError(`Duplicate node id: ${node.id}`);
    }
    nodeIds.add(node.id);
  }

  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) {
      throw new CanvasParseError(`Duplicate edge id: ${edge.id}`);
    }
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.fromNode)) {
      throw new CanvasParseError(`Edge ${edge.id} references unknown fromNode: ${edge.fromNode}`);
    }
    if (!nodeIds.has(edge.toNode)) {
      throw new CanvasParseError(`Edge ${edge.id} references unknown toNode: ${edge.toNode}`);
    }
  }

  let assets: Record<string, string> | undefined;
  if (d.assets !== undefined) {
    if (typeof d.assets !== 'object' || d.assets === null || Array.isArray(d.assets)) {
      throw new CanvasParseError('assets must be an object');
    }
    assets = {};
    for (const [key, value] of Object.entries(d.assets)) {
      assets[key] = assertString(value, `assets.${key}`);
    }
  }
  let notes: Record<string, string> | undefined;
  if (d.notes !== undefined) {
    if (typeof d.notes !== 'object' || d.notes === null || Array.isArray(d.notes)) {
      throw new CanvasParseError('notes must be an object');
    }
    notes = {};
    for (const [key, value] of Object.entries(d.notes)) {
      notes[key] = assertString(value, `notes.${key}`);
    }
  }

  return { nodes, edges, assets, notes };
}
