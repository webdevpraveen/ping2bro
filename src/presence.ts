// presence.ts
// ═══════════════════════════════════════════════════════════════════
// This file watches what the user is doing in VS Code
// and updates their Firebase presence status accordingly.
// It answers the question: "Is this person actively coding right now?"
// ═══════════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import { updatePresence, PresenceData } from './firebase';

// ─────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────

// Holds the idle timer reference so we can reset it on activity
let idleTimer: ReturnType<typeof setTimeout> | null = null;

// Holds all VS Code event disposables so we can clean them up later
let eventListeners: vscode.Disposable[] = [];

// Current user info — set when tracking starts
let currentUserId: string = '';
let currentUserName: string = '';
let currentUserPhoto: string = '';

// How long to wait before marking as idle (in milliseconds)
// Read from VS Code settings (default: 5 minutes)
function getIdleTimeout(): number {
  const config = vscode.workspace.getConfiguration('ping2bro');
  const minutes = config.get<number>('idleTimeoutMinutes', 5);
  return minutes * 60 * 1000;
}

// ─────────────────────────────────────────────────────────────────
// MAIN FUNCTIONS
// ─────────────────────────────────────────────────────────────────

/**
 * Starts tracking VS Code activity and syncing to Firebase.
 * Call this after the user logs in successfully.
 *
 * @param userId - Firebase UID
 * @param userName - Display name
 * @param photoURL - Profile photo URL
 */
export function startPresenceTracking(
  userId: string,
  userName: string,
  photoURL: string = ''
): void {
  // Save user info for use in event handlers
  currentUserId = userId;
  currentUserName = userName;
  currentUserPhoto = photoURL;

  // Mark as active immediately when tracking starts
  markActive('');

  // ── Event: User types something ──
  const onTextChange = vscode.workspace.onDidChangeTextDocument((event) => {
    // Get the file name (not full path — just the filename)
    const fileName = getShortFileName(event.document.fileName);
    markActive(fileName);
  });

  // ── Event: User opens a file ──
  const onFileOpen = vscode.workspace.onDidOpenTextDocument((document) => {
    const fileName = getShortFileName(document.fileName);
    markActive(fileName);
  });

  // ── Event: User switches between files (tabs) ──
  const onEditorChange = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      const fileName = getShortFileName(editor.document.fileName);
      markActive(fileName);
    }
  });

  // ── Event: VS Code window focus changes ──
  const onWindowStateChange = vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) {
      // Window came back into focus — user is back
      const currentFile = vscode.window.activeTextEditor
        ? getShortFileName(vscode.window.activeTextEditor.document.fileName)
        : '';
      markActive(currentFile);
    } else {
      // Window lost focus — user switched to another app
      markIdle();
    }
  });

  // ── Event: User saves a file ──
  const onFileSave = vscode.workspace.onDidSaveTextDocument((document) => {
    const fileName = getShortFileName(document.fileName);
    markActive(fileName);
  });

  // Store all listeners so we can dispose them later
  eventListeners = [
    onTextChange,
    onFileOpen,
    onEditorChange,
    onWindowStateChange,
    onFileSave
  ];

  console.log('Ping2Bro: Presence tracking started for', userName);
}

/**
 * Stops all event listeners and clears timers.
 * Call this when user logs out or VS Code closes.
 */
export function stopPresenceTracking(): void {
  // Clear idle timer
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  // Dispose all VS Code event listeners
  eventListeners.forEach(listener => listener.dispose());
  eventListeners = [];

  console.log('Ping2Bro: Presence tracking stopped');
}

// ─────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────

/**
 * Marks the user as ACTIVE and resets the idle timer.
 * Called whenever we detect any coding activity.
 */
function markActive(fileName: string): void {
  // Clear any existing idle timer
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  // Write active status to Firebase
  const presenceData: PresenceData = {
    name: currentUserName,
    status: 'active',
    currentFile: fileName,
    lastSeen: {},  // Will be replaced by serverTimestamp() in firebase.ts
    photoURL: currentUserPhoto
  };
  updatePresence(currentUserId, presenceData);

  // Start a new idle timer
  // If no activity for idleTimeout ms, automatically go idle
  idleTimer = setTimeout(() => {
    markIdle();
  }, getIdleTimeout());
}

/**
 * Marks the user as IDLE.
 * Called when no activity for idleTimeout, or window loses focus.
 */
function markIdle(): void {
  // Clear existing timer (don't want two timers running)
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  const presenceData: PresenceData = {
    name: currentUserName,
    status: 'idle',
    currentFile: '',
    lastSeen: {},
    photoURL: currentUserPhoto
  };
  updatePresence(currentUserId, presenceData);
}

/**
 * Marks the user as OFFLINE.
 * Called when user logs out or VS Code is closing.
 * Exported so extension.ts can call it on deactivate.
 */
export function markOfflineNow(): void {
  stopPresenceTracking();

  if (!currentUserId) {
    return;  // Not logged in, nothing to do
  }

  const presenceData: PresenceData = {
    name: currentUserName,
    status: 'offline',
    currentFile: '',
    lastSeen: {},
    photoURL: currentUserPhoto
  };
  updatePresence(currentUserId, presenceData);
}

/**
 * Extracts just the filename from a full path.
 * Example: "C:\Users\iampr\Documents\project\main.py" → "main.py"
 *
 * @param fullPath - Full file path
 * @returns Just the filename
 */
function getShortFileName(fullPath: string): string {
  if (!fullPath) {
    return '';
  }
  // Split on both / and \ to handle Windows and Unix paths
  const parts = fullPath.split(/[\\/]/);
  return parts[parts.length - 1] || '';
}
