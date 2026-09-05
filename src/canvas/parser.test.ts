import { expect, test } from 'bun:test';
import { CanvasParseError, parseCanvas } from './parser';
import type { CanvasEdgeData, CanvasNode } from './types';

const validCanvas = JSON.stringify({
  nodes: [
    {
      id: 'n1',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      text: 'hello',
    },
  ],
  edges: [],
});

test('parses valid canvas with empty edges', () => {
  const data = parseCanvas(validCanvas);
  expect(data.nodes).toHaveLength(1);
  expect(data.edges).toHaveLength(0);
  expect(data.nodes[0]?.id).toBe('n1');
});

test('parses canvas with missing nodes/edges arrays', () => {
  const data = parseCanvas('{}');
  expect(data.nodes).toHaveLength(0);
  expect(data.edges).toHaveLength(0);
});

test('parses all four node types', () => {
  const json = JSON.stringify({
    nodes: [
      {
        id: 't1',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        text: 'hello',
      },
      {
        id: 'f1',
        type: 'file',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        file: 'Note.md',
        subpath: '#heading',
      },
      {
        id: 'l1',
        type: 'link',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        url: 'https://example.com',
      },
      {
        id: 'g1',
        type: 'group',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        label: 'Group',
        background: 'bg.png',
        backgroundStyle: 'cover',
      },
    ],
    edges: [],
  });
  const data = parseCanvas(json);
  expect(data.nodes).toHaveLength(4);
  expect(data.nodes[0]?.type).toBe('text');
  expect(data.nodes[1]?.type).toBe('file');
  expect(data.nodes[2]?.type).toBe('link');
  expect(data.nodes[3]?.type).toBe('group');

  const textNode = data.nodes[0] as CanvasNode;
  if (textNode.type === 'text') expect(textNode.text).toBe('hello');

  const fileNode = data.nodes[1] as CanvasNode;
  if (fileNode.type === 'file') {
    expect(fileNode.file).toBe('Note.md');
    expect(fileNode.subpath).toBe('#heading');
  }

  const linkNode = data.nodes[2] as CanvasNode;
  if (linkNode.type === 'link') expect(linkNode.url).toBe('https://example.com');

  const groupNode = data.nodes[3] as CanvasNode;
  if (groupNode.type === 'group') {
    expect(groupNode.label).toBe('Group');
    expect(groupNode.background).toBe('bg.png');
    expect(groupNode.backgroundStyle).toBe('cover');
  }
});

test('parses optional fields correctly', () => {
  const json = JSON.stringify({
    nodes: [
      {
        id: 'n1',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        text: 'hi',
        color: '4',
      },
    ],
    edges: [
      {
        id: 'e1',
        fromNode: 'n1',
        toNode: 'n1',
        fromSide: 'right',
        toSide: 'left',
        fromEnd: 'arrow',
        toEnd: 'none',
        color: '#ff0000',
        label: 'test',
      },
    ],
  });
  const data = parseCanvas(json);
  expect(data.nodes[0]?.color).toBe('4');
  const edge = data.edges[0] as CanvasEdgeData;
  expect(edge.fromSide).toBe('right');
  expect(edge.toSide).toBe('left');
  expect(edge.fromEnd).toBe('arrow');
  expect(edge.toEnd).toBe('none');
  expect(edge.color).toBe('#ff0000');
  expect(edge.label).toBe('test');
});

test('edge defaults: missing fromSide/toSide/fromEnd/toEnd are undefined', () => {
  const json = JSON.stringify({
    nodes: [
      {
        id: 'n1',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        text: 'hi',
      },
    ],
    edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n1' }],
  });
  const data = parseCanvas(json);
  const edge = data.edges[0] as CanvasEdgeData;
  expect(edge.fromSide).toBeUndefined();
  expect(edge.toSide).toBeUndefined();
  expect(edge.fromEnd).toBeUndefined();
  expect(edge.toEnd).toBeUndefined();
});

test('throws on invalid JSON', () => {
  expect(() => parseCanvas('not json')).toThrow(CanvasParseError);
});

test('throws on non-object JSON', () => {
  expect(() => parseCanvas(JSON.stringify('string'))).toThrow(CanvasParseError);
  expect(() => parseCanvas('[]')).toThrow(CanvasParseError);
  expect(() => parseCanvas('42')).toThrow(CanvasParseError);
  expect(() => parseCanvas('null')).toThrow(CanvasParseError);
});

test('throws when nodes is not an array', () => {
  const json = JSON.stringify({ nodes: 'bad' });
  expect(() => parseCanvas(json)).toThrow(/nodes must be an array/);
});

test('throws when edges is not an array', () => {
  const json = JSON.stringify({ edges: 'bad' });
  expect(() => parseCanvas(json)).toThrow(/edges must be an array/);
});

test('throws on invalid node type', () => {
  const json = JSON.stringify({
    nodes: [{ id: 'n1', type: 'unknown', x: 0, y: 0, width: 100, height: 100 }],
    edges: [],
  });
  expect(() => parseCanvas(json)).toThrow(/Invalid node type/);
});

test('throws on missing required node fields', () => {
  const json = JSON.stringify({
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0 }],
    edges: [],
  });
  expect(() => parseCanvas(json)).toThrow(CanvasParseError);
});

test('throws on missing text for text node', () => {
  const json = JSON.stringify({
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 100 }],
    edges: [],
  });
  expect(() => parseCanvas(json)).toThrow(/node\.text/);
});

test('throws on missing file for file node', () => {
  const json = JSON.stringify({
    nodes: [{ id: 'n1', type: 'file', x: 0, y: 0, width: 100, height: 100 }],
    edges: [],
  });
  expect(() => parseCanvas(json)).toThrow(/node\.file/);
});

test('throws on missing url for link node', () => {
  const json = JSON.stringify({
    nodes: [{ id: 'n1', type: 'link', x: 0, y: 0, width: 100, height: 100 }],
    edges: [],
  });
  expect(() => parseCanvas(json)).toThrow(/node\.url/);
});

test('throws on invalid fromSide', () => {
  const json = JSON.stringify({
    nodes: [
      {
        id: 'n1',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        text: 'hi',
      },
    ],
    edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n1', fromSide: 'center' }],
  });
  expect(() => parseCanvas(json)).toThrow(/Invalid fromSide/);
});

test('throws on invalid toSide', () => {
  const json = JSON.stringify({
    nodes: [
      {
        id: 'n1',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        text: 'hi',
      },
    ],
    edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n1', toSide: 'middle' }],
  });
  expect(() => parseCanvas(json)).toThrow(/Invalid toSide/);
});

test('throws on invalid fromEnd', () => {
  const json = JSON.stringify({
    nodes: [
      {
        id: 'n1',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        text: 'hi',
      },
    ],
    edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n1', fromEnd: 'circle' }],
  });
  expect(() => parseCanvas(json)).toThrow(/Invalid fromEnd/);
});

test('throws on invalid toEnd', () => {
  const json = JSON.stringify({
    nodes: [
      {
        id: 'n1',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        text: 'hi',
      },
    ],
    edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n1', toEnd: 'diamond' }],
  });
  expect(() => parseCanvas(json)).toThrow(/Invalid toEnd/);
});

test('throws when edge references nonexistent node', () => {
  const json = JSON.stringify({
    nodes: [
      {
        id: 'n1',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        text: 'hi',
      },
    ],
    edges: [{ id: 'e1', fromNode: 'n1', toNode: 'ghost' }],
  });
  expect(() => parseCanvas(json)).toThrow(/references unknown.*toNode/);
});

test('throws when edge references nonexistent fromNode', () => {
  const json = JSON.stringify({
    nodes: [
      {
        id: 'n1',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        text: 'hi',
      },
    ],
    edges: [{ id: 'e1', fromNode: 'ghost', toNode: 'n1' }],
  });
  expect(() => parseCanvas(json)).toThrow(/references unknown.*fromNode/);
});

test('x, y, width, height must be finite numbers', () => {
  const json = JSON.stringify({
    nodes: [
      {
        id: 'n1',
        type: 'text',
        x: NaN,
        y: 0,
        width: 100,
        height: 100,
        text: 'hi',
      },
    ],
    edges: [],
  });
  expect(() => parseCanvas(json)).toThrow(/node\.x.*finite number/);
});

test('color can be hex, preset, or rgb', () => {
  const json = JSON.stringify({
    nodes: [
      {
        id: 'n1',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        text: 'a',
        color: '#ff0000',
      },
      {
        id: 'n2',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        text: 'b',
        color: '3',
      },
      {
        id: 'n3',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        text: 'c',
        color: 'rgb(255,0,0)',
      },
    ],
    edges: [],
  });
  const data = parseCanvas(json);
  expect(data.nodes[0]?.color).toBe('#ff0000');
  expect(data.nodes[1]?.color).toBe('3');
  expect(data.nodes[2]?.color).toBe('rgb(255,0,0)');
});

test('subpath is optional on file nodes', () => {
  const json = JSON.stringify({
    nodes: [
      {
        id: 'n1',
        type: 'file',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        file: 'Note.md',
      },
    ],
    edges: [],
  });
  const data = parseCanvas(json);
  const node = data.nodes[0] as CanvasNode;
  if (node.type === 'file') expect(node.subpath).toBeUndefined();
});

test('label and background are optional on group nodes', () => {
  const json = JSON.stringify({
    nodes: [{ id: 'n1', type: 'group', x: 0, y: 0, width: 100, height: 100 }],
    edges: [],
  });
  const data = parseCanvas(json);
  const node = data.nodes[0] as CanvasNode;
  if (node.type === 'group') {
    expect(node.label).toBeUndefined();
    expect(node.background).toBeUndefined();
  }
});

test('parses enriched file node fields', () => {
  const json = JSON.stringify({
    nodes: [
      {
        id: 'n1',
        type: 'file',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        file: 'Welcome.md',
        fileContent: 'Hello world content',
        imageUrl: 'data:image/png;base64,123',
        isImage: true,
      },
    ],
    edges: [],
  });
  const data = parseCanvas(json);
  const node = data.nodes[0] as CanvasNode;
  if (node.type === 'file') {
    expect(node.fileContent).toBe('Hello world content');
    expect(node.imageUrl).toBe('data:image/png;base64,123');
    expect(node.isImage).toBe(true);
  }
});

test('parses real Demo.canvas file', async () => {
  const content = await Bun.file('Obsidian Vault/Demo.canvas').text();
  const data = parseCanvas(content);
  expect(data.nodes).toHaveLength(5);
  expect(data.edges).toHaveLength(3);
  expect(data.nodes.map((n) => n.type)).toEqual(['group', 'file', 'text', 'text', 'link']);
});
test('accepts fractional geometry', () => {
  const canvas = {
    nodes: [
      {
        id: 'n1',
        type: 'text',
        x: 0.5,
        y: -10.25,
        width: 100,
        height: 100,
        text: 'text',
      },
    ],
    edges: [],
  };
  const data = parseCanvas(JSON.stringify(canvas));
  expect(data.nodes[0]?.x).toBe(0.5);
  expect(data.nodes[0]?.y).toBe(-10.25);
});

test('rejects non-finite geometry', () => {
  for (const value of [Infinity, -Infinity, NaN]) {
    const canvas = {
      nodes: [{ id: 'n1', type: 'text', x: value, y: 0, width: 100, height: 100, text: 'text' }],
      edges: [],
    };
    expect(() => parseCanvas(JSON.stringify(canvas))).toThrow(/node\.x.*finite number/);
  }
});

test('rejects duplicate node and edge ids', () => {
  const duplicateNodes = {
    nodes: [
      { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 100, text: 'a' },
      { id: 'n1', type: 'text', x: 100, y: 0, width: 100, height: 100, text: 'b' },
    ],
    edges: [],
  };
  expect(() => parseCanvas(JSON.stringify(duplicateNodes))).toThrow(/Duplicate node id/);

  const duplicateEdges = {
    nodes: [
      { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 100, text: 'a' },
      { id: 'n2', type: 'text', x: 100, y: 0, width: 100, height: 100, text: 'b' },
    ],
    edges: [
      { id: 'e1', fromNode: 'n1', toNode: 'n2' },
      { id: 'e1', fromNode: 'n2', toNode: 'n1' },
    ],
  };
  expect(() => parseCanvas(JSON.stringify(duplicateEdges))).toThrow(/Duplicate edge id/);
});
