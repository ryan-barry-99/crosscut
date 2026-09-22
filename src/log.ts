import * as vscode from 'vscode';

// The output channel and the most recent GitHub CLI failure, set up in activate().

export let log: vscode.LogOutputChannel;
export let lastGhError: string | undefined; // most recent GitHub CLI failure, shown instead of "not found"

/** Called once from activate(): nothing may log before it. */
export function setLog(channel: vscode.LogOutputChannel) {
  log = channel;
}

/** Called by the gh error handler with the message it last saw. */
export function setLastGhError(message: string | undefined) {
  lastGhError = message;
}
