// notifications.ts
// ═══════════════════════════════════════════════════════════════════
// Shows VS Code notification popups when MUTUAL FRIENDS come online.
// Example: "⚡ Rahul just started coding! (index.js)"
// We track previous state to avoid showing the same notification twice.
// Only friends in the user's mutual friends list trigger notifications.
// ═══════════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import { PresenceData } from './firebase';

// Stores the last known status of each user
// Key: userId, Value: their status ('active' | 'idle' | 'offline')
const previousStatuses: Map<string, string> = new Map();

// The current logged-in user's ID — we don't notify about ourselves
let myUserId: string = '';

// Set of friend UIDs — only notify about these users
let friendUids: Set<string> = new Set();

/**
 * Sets the current user's ID.
 * We use this to skip notifications about our own status changes.
 */
export function setMyUserId(userId: string): void {
  myUserId = userId;
}

/**
 * Updates the friend list used for filtering notifications.
 * Only users in this set will trigger notifications.
 *
 * @param friends - Set of friend UIDs from Firebase
 */
export function updateFriendsList(friends: Set<string>): void {
  friendUids = friends;
}

/**
 * Checks new presence data against old data.
 * Shows a notification if any MUTUAL FRIEND changed from non-active to active.
 *
 * @param presenceData - Latest presence data from Firebase
 */
export function checkForNotifications(
  presenceData: Record<string, PresenceData> | null
): void {
  // If no data or notifications are disabled, do nothing
  if (!presenceData) {
    return;
  }

  const config = vscode.workspace.getConfiguration('ping2bro');
  const showNotifications = config.get<boolean>('showNotifications', true);
  if (!showNotifications) {
    return;
  }

  // Check each user in the presence data
  Object.entries(presenceData).forEach(([userId, userData]) => {
    // Skip our own status
    if (userId === myUserId) {
      previousStatuses.set(userId, userData.status);
      return;
    }

    // Skip users who are NOT our mutual friends
    if (!friendUids.has(userId)) {
      return;
    }

    const previousStatus = previousStatuses.get(userId);
    const newStatus = userData.status;

    // Detect transition TO active (came online and started coding)
    if (newStatus === 'active' && previousStatus !== 'active') {
      // Only notify if we have a previous status (not first load)
      if (previousStatus !== undefined) {
        const fileInfo = userData.currentFile
          ? ` (${userData.currentFile})`
          : '';

        const message = `⚡ ${userData.name} just started coding!${fileInfo}`;

        // Show VS Code information message with action button
        vscode.window.showInformationMessage(
          message,
          'Open Chat'
        ).then((selection) => {
          if (selection === 'Open Chat') {
            // Focus the Ping2Bro sidebar when user clicks "Open Chat"
            vscode.commands.executeCommand('ping2bro-sidebar.focus');
          }
        });
      }
    }

    // Update tracked status
    previousStatuses.set(userId, newStatus);
  });
}

/**
 * Clears all tracked statuses.
 * Call when user logs out.
 */
export function clearNotificationState(): void {
  previousStatuses.clear();
  friendUids = new Set();
}
