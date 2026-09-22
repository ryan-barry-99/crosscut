// Just enough of the `vscode` module for the extension's modules to load and run under node:test.
// Import this before any module that imports 'vscode'. Calls tests care about are recorded.
import Module = require('module');
import * as path from 'path';

export const executed: { command: string; args: unknown[] }[] = [];
export const config: Record<string, unknown> = {};

class Disposable {
  constructor(private readonly fn: () => void = () => undefined) {}
  static from(...ds: { dispose(): unknown }[]) {
    return new Disposable(() => ds.forEach((d) => d.dispose()));
  }
  dispose() {
    this.fn();
  }
}

class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (fn: (e: T) => void) => {
    this.listeners.push(fn);
    return new Disposable(() => (this.listeners = this.listeners.filter((l) => l !== fn)));
  };
  fire(e: T) {
    this.listeners.forEach((l) => l(e));
  }
  dispose() {
    this.listeners = [];
  }
}

class Uri {
  private constructor(readonly scheme: string, readonly path: string, readonly query: string, readonly fragment: string) {}
  static file(p: string) {
    return new Uri('file', path.resolve(p), '', '');
  }
  static from(c: { scheme: string; path?: string; query?: string; fragment?: string }) {
    return new Uri(c.scheme, c.path ?? '', c.query ?? '', c.fragment ?? '');
  }
  static parse(s: string) {
    const m = /^([\w.+-]+):(?:\/\/)?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(s);
    return m ? new Uri(m[1], m[2], m[3] ?? '', m[4] ?? '') : Uri.file(s);
  }
  get fsPath() {
    return this.path;
  }
  with(c: { scheme?: string; path?: string; query?: string; fragment?: string }) {
    return new Uri(c.scheme ?? this.scheme, c.path ?? this.path, c.query ?? this.query, c.fragment ?? this.fragment);
  }
  toString() {
    return `${this.scheme}://${this.path}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
  }
}

class Position {
  constructor(readonly line: number, readonly character: number) {}
}
class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
    this.start = typeof a === 'number' ? new Position(a, b as number) : a;
    this.end = typeof a === 'number' ? new Position(c!, d!) : (b as Position);
  }
}
class Selection extends Range {}

class MarkdownString {
  isTrusted?: boolean;
  supportHtml?: boolean;
  supportThemeIcons?: boolean;
  constructor(public value = '', supportThemeIcons = false) {
    this.supportThemeIcons = supportThemeIcons;
  }
  appendMarkdown(s: string) {
    this.value += s;
    return this;
  }
  appendText(s: string) {
    this.value += s;
    return this;
  }
  appendCodeblock(s: string) {
    this.value += '\n```\n' + s + '\n```\n';
    return this;
  }
}

class ThemeIcon {
  static File = new ThemeIcon('file');
  static Folder = new ThemeIcon('folder');
  constructor(readonly id: string, readonly color?: unknown) {}
}
class ThemeColor {
  constructor(readonly id: string) {}
}
class TreeItem {
  description?: string;
  tooltip?: unknown;
  iconPath?: unknown;
  contextValue?: string;
  id?: string;
  command?: unknown;
  resourceUri?: Uri;
  constructor(readonly label: unknown, readonly collapsibleState = 0) {}
}
class RelativePattern {
  constructor(readonly base: unknown, readonly pattern: string) {}
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, appendLine() {}, show() {}, dispose() {} };

export const window = {
  tabGroups: { all: [] as unknown[], activeTabGroup: { activeTab: undefined as unknown, tabs: [] as unknown[] }, close: async () => true, onDidChangeTabs: () => new Disposable() },
  activeTextEditor: undefined as unknown,
  visibleTextEditors: [] as unknown[],
  createTextEditorDecorationType: () => ({ key: 'decoration', dispose() {} }),
  createOutputChannel: () => noopLog,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showQuickPick: async () => undefined,
  showTextDocument: async () => undefined,
  registerFileDecorationProvider: () => new Disposable(),
};

export const workspace = {
  workspaceFolders: undefined as { uri: Uri; name: string; index: number }[] | undefined,
  getConfiguration: () => ({ get: (key: string, def?: unknown) => (key in config ? config[key] : def) }),
  createFileSystemWatcher: () => ({ onDidChange: () => new Disposable(), onDidCreate: () => new Disposable(), onDidDelete: () => new Disposable(), dispose() {} }),
  openTextDocument: async () => ({}),
  registerTextDocumentContentProvider: () => new Disposable(),
};

export const commands = {
  executeCommand: async (command: string, ...args: unknown[]) => {
    executed.push({ command, args });
    return undefined;
  },
  registerCommand: () => new Disposable(),
};

export const comments = {
  createCommentController: () => ({ createCommentThread: () => ({ dispose() {}, comments: [] }), dispose() {} }),
};

const vscode = {
  Disposable,
  EventEmitter,
  Uri,
  Position,
  Range,
  Selection,
  MarkdownString,
  ThemeIcon,
  ThemeColor,
  TreeItem,
  RelativePattern,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  CommentMode: { Editing: 0, Preview: 1 },
  CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
  window,
  workspace,
  commands,
  comments,
  languages: { registerHoverProvider: () => new Disposable() },
};

const load = (Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown });
const original = load._load;
load._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscode : original.call(this, request, ...rest);
};

/** A Memento backed by a Map, for workspaceState. */
export class Memento {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, def?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : def;
  }
  async update(key: string, value: unknown) {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }
  keys() {
    return [...this.values.keys()];
  }
}

export { Uri as FakeUri };
