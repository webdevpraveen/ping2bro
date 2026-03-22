// sidebar.ts
// ═══════════════════════════════════════════════════════════════════
// This file creates the sidebar panel inside VS Code.
// The sidebar has THREE tabs:
//   1. Friends — your Ping Code, add friend by code, pending requests
//   2. Online  — presence list of MUTUAL FRIENDS only
//   3. Chat    — direct messages with a selected friend
//
// VS Code uses a "Webview" for custom UI — it's basically an iframe.
// We communicate between VS Code (TypeScript) and the webview using postMessage.
// ═══════════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import {
  listenToPresence,
  listenToMessages,
  sendMessage,
  getDMRoomId,
  listenToFriends,
  listenToFriendRequests,
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  lookupUserByPingCode,
  getPingCodeForUser,
  auth,
  PresenceData,
  MessageData,
  FriendRequest
} from './firebase';
import { checkForNotifications, setMyUserId, updateFriendsList } from './notifications';

export class Ping2BroSidebarProvider implements vscode.WebviewViewProvider {

  // Reference to the webview so we can send messages to it later
  private _view?: vscode.WebviewView;

  // Unsubscribe functions for Firebase listeners
  private _presenceUnsubscribe?: () => void;
  private _friendsUnsubscribe?: () => void;
  private _friendRequestsUnsubscribe?: () => void;
  private _messagesUnsubscribe?: () => void;

  // Current user's friend UIDs — used to filter presence
  private _friendUids: Set<string> = new Set();

  // The extension URI — needed for local resources
  constructor(private readonly _extensionUri: vscode.Uri) {}

  /**
   * VS Code calls this when the sidebar panel is first opened.
   * We set up the webview HTML and start listening to Firebase.
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    // Enable JavaScript in the webview and allow loading local resources
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    // Set the HTML content for the sidebar
    webviewView.webview.html = this._getWebviewHTML();

    // ── Start Firebase listeners (only when user is logged in) ──
    this._setupFirebaseListeners();

    // ── Listen to messages FROM the webview ──
    webviewView.webview.onDidReceiveMessage(async (message) => {
      const user = auth.currentUser;
      
      // Require user to be logged in for most actions (except login/register flow)
      if (!user) {
        if (message.type === 'requestLogin') {
          vscode.commands.executeCommand('ping2bro.login');
        } else if (message.type === 'requestRegister') {
          vscode.commands.executeCommand('ping2bro.register');
        }
        return;
      }

      switch (message.type) {

        case 'sendMessage':
          // User typed a DM — send it to the selected friend
          if (message.friendUid) {
            sendMessage(
              user.uid,
              message.friendUid,
              user.displayName || 'Developer',
              message.text,
              user.photoURL || ''
            );
          }
          break;

        case 'addFriend':
          // User entered a Ping Code to add a friend
          await this._handleAddFriend(user, message.pingCode);
          break;

        case 'acceptRequest':
          // User accepted a friend request
          await acceptFriendRequest(user.uid, message.friendUid);
          this._postToWebview({ type: 'friendActionResult', success: true, message: 'Friend added! 🎉' });
          break;

        case 'declineRequest':
          // User declined a friend request
          await declineFriendRequest(user.uid, message.friendUid);
          this._postToWebview({ type: 'friendActionResult', success: true, message: 'Request declined.' });
          break;

        case 'openChat':
          // User clicked on a friend to open DM
          this._switchToDM(user.uid, message.friendUid, message.friendName);
          break;
      }
    });

    // Clean up Firebase listeners when the sidebar is closed
    webviewView.onDidDispose(() => {
      this._cleanupListeners();
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // FIREBASE LISTENER MANAGEMENT
  // ─────────────────────────────────────────────────────────────────

  /**
   * Sets up all Firebase real-time listeners.
   * Called when the webview is created and when user logs in.
   */
  private _setupFirebaseListeners(): void {
    const user = auth.currentUser;
    if (!user) {
      return;
    }

    // ── Listen to friends list changes ──
    this._friendsUnsubscribe = listenToFriends(user.uid, (friends) => {
      this._friendUids = friends;
      // Update the notification module's friend list
      updateFriendsList(friends);
      // Send friend UIDs to the webview so it can filter presence
      this._postToWebview({
        type: 'friendsListUpdate',
        friendUids: Array.from(friends)
      });
    });

    // ── Listen to presence data ──
    this._presenceUnsubscribe = listenToPresence((data) => {
      if (data) {
        checkForNotifications(data);
      }
      // Send ALL presence data; the webview filters to friends only
      this._postToWebview({
        type: 'presenceUpdate',
        data: data
      });
    });

    // ── Listen to incoming friend requests ──
    this._friendRequestsUnsubscribe = listenToFriendRequests(user.uid, (requests) => {
      this._postToWebview({
        type: 'friendRequestsUpdate',
        data: requests
      });
    });
  }

  /**
   * Cleans up all Firebase listeners to prevent memory leaks.
   */
  private _cleanupListeners(): void {
    if (this._presenceUnsubscribe) { this._presenceUnsubscribe(); }
    if (this._friendsUnsubscribe) { this._friendsUnsubscribe(); }
    if (this._friendRequestsUnsubscribe) { this._friendRequestsUnsubscribe(); }
    if (this._messagesUnsubscribe) { this._messagesUnsubscribe(); }
  }

  // ─────────────────────────────────────────────────────────────────
  // FRIEND & CHAT HELPERS
  // ─────────────────────────────────────────────────────────────────

  /**
   * Handles the "Add Friend" action from the webview.
   * Looks up the Ping Code and sends a friend request.
   */
  private async _handleAddFriend(user: any, pingCode: string): Promise<void> {
    if (!pingCode || !pingCode.trim()) {
      this._postToWebview({ type: 'friendActionResult', success: false, message: 'Please enter a Ping Code.' });
      return;
    }

    // Look up the user by Ping Code
    const targetUser = await lookupUserByPingCode(pingCode.trim());
    if (!targetUser) {
      this._postToWebview({ type: 'friendActionResult', success: false, message: 'No user found with that Ping Code. 🤔' });
      return;
    }

    // Get my Ping Code for the request
    const myPingCode = await getPingCodeForUser(user.uid) || 'UNKNOWN';

    // Send the friend request
    const result = await sendFriendRequest(
      user.uid,
      targetUser.uid,
      user.displayName || 'Developer',
      user.photoURL || '',
      myPingCode
    );

    this._postToWebview({ type: 'friendActionResult', success: result.success, message: result.message });
  }

  /**
   * Switches the chat to a DM with a specific friend.
   * Stops listening to any previous DM room and starts listening to the new one.
   */
  private _switchToDM(myUid: string, friendUid: string, friendName: string): void {
    // Unsubscribe from previous DM room if any
    if (this._messagesUnsubscribe) {
      this._messagesUnsubscribe();
    }

    const roomId = getDMRoomId(myUid, friendUid);

    // Start listening to the new DM room
    this._messagesUnsubscribe = listenToMessages(roomId, (data) => {
      this._postToWebview({
        type: 'messageUpdate',
        data: data,
        friendUid: friendUid,
        friendName: friendName
      });
    });
  }

  /**
   * Safely posts a message to the webview (if it exists).
   */
  private _postToWebview(message: any): void {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // PUBLIC METHODS (called from extension.ts)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Notifies the webview that the user has logged in.
   * Also starts Firebase listeners and sends user info.
   */
  public notifyLogin(userName: string, photoURL: string, userId: string, pingCode: string): void {
    // Start firebase listeners now that we have a user
    this._setupFirebaseListeners();

    // Set notification manager's user ID
    setMyUserId(userId);

    // Tell the webview
    this._postToWebview({
      type: 'loginSuccess',
      userName: userName,
      photoURL: photoURL,
      userId: userId,
      pingCode: pingCode
    });
  }

  /**
   * Notifies the webview that the user has logged out.
   */
  public notifyLogout(): void {
    this._cleanupListeners();
    this._friendUids = new Set();
    this._postToWebview({ type: 'logout' });
  }

  // ─────────────────────────────────────────────────────────────────
  // HTML CONTENT — The entire sidebar UI with 3 tabs
  // ─────────────────────────────────────────────────────────────────

  private _getWebviewHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ping2Bro</title>
<style>
  /* ── Reset & Base ── */
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: 13px;
    background: transparent;
    color: var(--vscode-foreground);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Login Screen ── */
  #login-screen {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 20px;
    text-align: center;
  }

  #login-screen .logo { font-size: 32px; margin-bottom: 4px; }

  #login-screen p {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    line-height: 1.5;
  }

  .btn-login {
    background: var(--vscode-button-background, #0078d4);
    color: var(--vscode-button-foreground, white);
    border: none;
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    width: 140px;
    transition: background 0.2s;
  }
  .btn-login:hover { background: var(--vscode-button-hoverBackground, #005fa3); }

  .btn-register {
    background: transparent;
    color: var(--vscode-button-background, #0078d4);
    border: 1px solid var(--vscode-button-background, #0078d4);
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    width: 140px;
    transition: all 0.2s;
  }
  .btn-register:hover { 
    background: rgba(0, 120, 212, 0.1); 
  }

  /* ── App Screen ── */
  #app-screen {
    flex: 1;
    display: none;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── User Bar ── */
  .user-bar {
    padding: 8px 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid var(--vscode-sideBar-border, #333);
    background: var(--vscode-sideBarSectionHeader-background, #1e1e1e);
  }

  .user-avatar {
    width: 22px; height: 22px;
    border-radius: 50%;
    object-fit: cover;
    background: #555;
  }

  .user-name {
    flex: 1;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #4caf50;
    flex-shrink: 0;
  }

  /* ── Tab Bar ── */
  .tab-bar {
    display: flex;
    border-bottom: 1px solid var(--vscode-sideBar-border, #333);
    background: var(--vscode-sideBarSectionHeader-background, #1e1e1e);
  }

  .tab-btn {
    flex: 1;
    padding: 8px 4px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--vscode-descriptionForeground, #888);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    transition: all 0.2s;
    white-space: nowrap;
  }

  .tab-btn:hover {
    color: var(--vscode-foreground);
    background: rgba(255,255,255,0.03);
  }

  .tab-btn.active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder, #007acc);
  }

  .tab-badge {
    display: inline-block;
    background: #e53935;
    color: white;
    font-size: 9px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 8px;
    margin-left: 4px;
    vertical-align: middle;
  }

  /* ── Tab Content ── */
  .tab-content {
    flex: 1;
    overflow-y: auto;
    display: none;
    flex-direction: column;
  }

  .tab-content.active {
    display: flex;
  }

  /* ── Section Titles ── */
  .section-title {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--vscode-sideBarSectionHeader-foreground, #888);
    padding: 10px 12px 6px;
  }

  /* ── Ping Code Card ── */
  .ping-code-card {
    margin: 10px 10px 6px;
    padding: 12px;
    background: rgba(0,120,212,0.08);
    border: 1px solid rgba(0,120,212,0.2);
    border-radius: 8px;
    text-align: center;
  }

  .ping-code-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 6px;
  }

  .ping-code-value {
    font-size: 20px;
    font-weight: 700;
    font-family: 'Consolas', 'Courier New', monospace;
    color: var(--vscode-foreground);
    letter-spacing: 0.15em;
    user-select: all;
  }

  .btn-copy {
    margin-top: 8px;
    background: var(--vscode-button-background, #0078d4);
    color: var(--vscode-button-foreground, white);
    border: none;
    padding: 4px 14px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    transition: background 0.15s;
  }
  .btn-copy:hover { background: var(--vscode-button-hoverBackground, #005fa3); }

  /* ── Add Friend Input ── */
  .add-friend-row {
    display: flex;
    gap: 6px;
    padding: 8px 10px;
  }

  .add-friend-row input {
    flex: 1;
    background: var(--vscode-input-background, #3c3c3c);
    border: 1px solid var(--vscode-input-border, #555);
    color: var(--vscode-input-foreground, #ccc);
    padding: 5px 10px;
    border-radius: 6px;
    font-size: 12px;
    outline: none;
    font-family: 'Consolas', monospace;
    text-transform: uppercase;
  }
  .add-friend-row input:focus {
    border-color: var(--vscode-focusBorder, #007acc);
  }
  .add-friend-row input::placeholder {
    color: var(--vscode-input-placeholderForeground, #888);
    text-transform: none;
    font-family: 'Segoe UI', system-ui, sans-serif;
  }

  .btn-add {
    background: var(--vscode-button-background, #0078d4);
    color: var(--vscode-button-foreground, white);
    border: none;
    padding: 5px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    transition: background 0.15s;
  }
  .btn-add:hover { background: var(--vscode-button-hoverBackground, #005fa3); }

  /* ── Action Result Toast ── */
  .action-result {
    padding: 6px 10px;
    font-size: 11px;
    text-align: center;
    display: none;
    border-radius: 4px;
    margin: 4px 10px;
  }
  .action-result.success {
    background: rgba(76,175,80,0.15);
    color: #81c784;
  }
  .action-result.error {
    background: rgba(229,57,53,0.15);
    color: #ef9a9a;
  }

  /* ── Request Card ── */
  .request-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 6px;
  }
  .request-item:hover {
    background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05));
  }

  .request-avatar {
    width: 26px; height: 26px;
    border-radius: 50%;
    object-fit: cover;
    background: #444;
    flex-shrink: 0;
  }

  .request-info { flex: 1; min-width: 0; }

  .request-name {
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .request-code {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    font-family: 'Consolas', monospace;
  }

  .request-actions { display: flex; gap: 4px; flex-shrink: 0; }

  .btn-accept, .btn-decline {
    border: none;
    padding: 3px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 10px;
    font-weight: 600;
    transition: opacity 0.15s;
  }
  .btn-accept {
    background: #4caf50;
    color: white;
  }
  .btn-decline {
    background: #555;
    color: #ccc;
  }
  .btn-accept:hover, .btn-decline:hover { opacity: 0.85; }

  /* ── Presence Items ── */
  .presence-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
  }
  .presence-item:hover {
    background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05));
  }

  .presence-avatar-wrap {
    position: relative;
    width: 28px; height: 28px;
    flex-shrink: 0;
  }

  .presence-avatar {
    width: 28px; height: 28px;
    border-radius: 50%;
    object-fit: cover;
    background: #444;
  }

  .presence-status-dot {
    position: absolute;
    bottom: 0; right: 0;
    width: 9px; height: 9px;
    border-radius: 50%;
    border: 2px solid var(--vscode-sideBar-background, #1e1e1e);
  }

  .dot-active { background: #4caf50; }
  .dot-idle   { background: #ff9800; }
  .dot-offline { background: #555; }

  .presence-info { flex: 1; min-width: 0; }

  .presence-name {
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .presence-file {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chat-hint {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    opacity: 0;
    transition: opacity 0.15s;
    flex-shrink: 0;
  }
  .presence-item:hover .chat-hint { opacity: 1; }

  /* ── Empty State ── */
  .empty-state {
    padding: 16px 12px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    text-align: center;
    font-style: italic;
  }

  /* ── Divider ── */
  .divider {
    height: 1px;
    background: var(--vscode-sideBar-border, #333);
    margin: 4px 0;
  }

  /* ── Chat Section (inside Chat tab) ── */
  .chat-header {
    padding: 8px 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid var(--vscode-sideBar-border, #333);
    background: var(--vscode-sideBarSectionHeader-background, #1e1e1e);
  }

  .chat-header-name {
    flex: 1;
    font-size: 12px;
    font-weight: 600;
  }

  .btn-back {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 14px;
    padding: 2px 6px;
    border-radius: 4px;
    transition: background 0.15s;
  }
  .btn-back:hover { background: rgba(255,255,255,0.08); }

  #chat-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
  }

  #no-chat-selected {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    text-align: center;
    padding: 20px;
  }

  #active-chat {
    flex: 1;
    display: none;
    flex-direction: column;
    overflow: hidden;
  }

  #messages-container {
    flex: 1;
    overflow-y: auto;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .message {
    display: flex;
    gap: 7px;
    padding: 4px 6px;
    border-radius: 6px;
  }
  .message:hover {
    background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.03));
  }

  .msg-avatar {
    width: 22px; height: 22px;
    border-radius: 50%;
    object-fit: cover;
    background: #444;
    flex-shrink: 0;
    margin-top: 1px;
  }

  .msg-body { flex: 1; min-width: 0; }

  .msg-header {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin-bottom: 1px;
  }

  .msg-name {
    font-size: 11px;
    font-weight: 600;
    color: #79b8ff;
  }

  .msg-time {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
  }

  .msg-text {
    font-size: 12px;
    word-break: break-word;
    line-height: 1.4;
  }

  /* ── Chat Input ── */
  .chat-input-bar {
    padding: 8px;
    border-top: 1px solid var(--vscode-sideBar-border, #333);
    display: flex;
    gap: 6px;
    background: var(--vscode-sideBar-background);
  }

  #chat-input {
    flex: 1;
    background: var(--vscode-input-background, #3c3c3c);
    border: 1px solid var(--vscode-input-border, #555);
    color: var(--vscode-input-foreground, #ccc);
    padding: 5px 10px;
    border-radius: 6px;
    font-size: 12px;
    outline: none;
    font-family: inherit;
  }
  #chat-input:focus { border-color: var(--vscode-focusBorder, #007acc); }
  #chat-input::placeholder { color: var(--vscode-input-placeholderForeground, #888); }

  .btn-send {
    background: var(--vscode-button-background, #0078d4);
    color: var(--vscode-button-foreground, white);
    border: none;
    padding: 5px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    transition: background 0.15s;
  }
  .btn-send:hover { background: var(--vscode-button-hoverBackground, #005fa3); }

  /* ── Scrollbar ── */
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background, #555);
    border-radius: 4px;
  }
</style>
</head>
<body>

<!-- ═══ LOGIN SCREEN ═══ -->
<div id="login-screen">
  <div class="logo">⚡</div>
  <h2>Ping2Bro</h2>
  <p>Code with your friends.<br>See who's active, chat inside VS Code.</p>
  <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 10px;">
    <button class="btn-login" id="btn-login">Login</button>
    <button class="btn-register" id="btn-register">Create Account</button>
  </div>
</div>

<!-- ═══ APP SCREEN ═══ -->
<div id="app-screen">

  <!-- User info bar -->
  <div class="user-bar">
    <img id="my-avatar" class="user-avatar" src="" alt="You" onerror="this.style.display='none'">
    <span id="my-name" class="user-name">Loading...</span>
    <div class="status-dot"></div>
  </div>

  <!-- Tab bar -->
  <div class="tab-bar">
    <button class="tab-btn active" data-tab="friends" onclick="switchTab('friends')">
      👥 Friends<span id="requests-badge" class="tab-badge" style="display:none;">0</span>
    </button>
    <button class="tab-btn" data-tab="online" onclick="switchTab('online')">
      🟢 Online
    </button>
    <button class="tab-btn" data-tab="chat" onclick="switchTab('chat')">
      💬 Chat
    </button>
  </div>

  <!-- ═══ TAB: FRIENDS ═══ -->
  <div id="tab-friends" class="tab-content active">
    <!-- Ping Code card -->
    <div class="ping-code-card">
      <div class="ping-code-label">Your Ping Code</div>
      <div id="my-ping-code" class="ping-code-value">---</div>
      <button class="btn-copy" onclick="copyPingCode()">📋 Copy Code</button>
    </div>

    <!-- Add friend input -->
    <div class="section-title">Add a Friend</div>
    <div class="add-friend-row">
      <input id="add-friend-input" type="text" placeholder="Enter Ping Code..." maxlength="10" spellcheck="false" />
      <button class="btn-add" onclick="addFriend()">Add</button>
    </div>
    <div id="action-result" class="action-result"></div>

    <!-- Pending friend requests -->
    <div class="section-title">Pending Requests 📩</div>
    <div id="requests-list">
      <div class="empty-state">No pending requests</div>
    </div>

    <div class="divider"></div>

    <!-- My friends list -->
    <div class="section-title">My Friends 🤝</div>
    <div id="friends-list">
      <div class="empty-state">Add friends using their Ping Code!</div>
    </div>
  </div>

  <!-- ═══ TAB: ONLINE (Presence) ═══ -->
  <div id="tab-online" class="tab-content">
    <div class="section-title">Who's Coding 👀</div>
    <div id="presence-list">
      <div class="empty-state">Add some friends to see who's online!</div>
    </div>
  </div>

  <!-- ═══ TAB: CHAT (DMs) ═══ -->
  <div id="tab-chat" class="tab-content">
    <div id="no-chat-selected">
      <div>
        <div style="font-size:24px; margin-bottom:8px;">💬</div>
        <div>Click a friend in the<br><b>Online</b> tab to start chatting!</div>
      </div>
    </div>
    <div id="active-chat">
      <div class="chat-header">
        <button class="btn-back" onclick="closeChat()">←</button>
        <span id="chat-friend-name" class="chat-header-name">...</span>
      </div>
      <div id="messages-container">
        <div class="empty-state" style="font-style:normal;">No messages yet. Say hi! 👋</div>
      </div>
      <div class="chat-input-bar">
        <input id="chat-input" type="text" placeholder="Type a message..." maxlength="500" autocomplete="off" />
        <button class="btn-send" onclick="sendMsg()">Send</button>
      </div>
    </div>
  </div>

</div>

<script>
  // ── VS Code API ──
  const vscode = acquireVsCodeApi();

  // ── State ──
  let myUserId = null;
  let myPingCode = '';
  let friendUids = new Set();          // UIDs of mutual friends
  let presenceData = {};               // All presence data from Firebase
  let friendProfiles = {};             // { uid: { name, photoURL } } from presence
  let currentChatFriendUid = null;     // UID of the friend we're chatting with
  let currentChatFriendName = '';

  // ── Tab Switching ──
  function switchTab(tabName) {
    // Deactivate all tabs
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
    // Activate selected tab
    document.querySelector('[data-tab="' + tabName + '"]').classList.add('active');
    document.getElementById('tab-' + tabName).classList.add('active');
  }

  // ── Login / Register ──
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btn-login').addEventListener('click', () => {
      vscode.postMessage({ type: 'requestLogin' });
    });

    document.getElementById('btn-register').addEventListener('click', () => {
      vscode.postMessage({ type: 'requestRegister' });
    });
  });

  // ── Copy Ping Code ──
  function copyPingCode() {
    const code = document.getElementById('my-ping-code').textContent;
    if (code && code !== '---') {
      // Use a temporary textarea to copy (webview has no navigator.clipboard)
      const textarea = document.createElement('textarea');
      textarea.value = code;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      showActionResult(true, 'Copied! Share it with your friends 🎉');
    }
  }

  // ── Add Friend ──
  function addFriend() {
    const input = document.getElementById('add-friend-input');
    const code = input.value.trim().toUpperCase();
    if (!code) return;
    vscode.postMessage({ type: 'addFriend', pingCode: code });
    input.value = '';
  }

  // Enter key to add friend
  document.getElementById('add-friend-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); addFriend(); }
  });

  // ── Accept / Decline friend request ──
  function acceptReq(uid) {
    vscode.postMessage({ type: 'acceptRequest', friendUid: uid });
  }
  function declineReq(uid) {
    vscode.postMessage({ type: 'declineRequest', friendUid: uid });
  }

  // ── Open Chat with a friend ──
  function openChat(friendUid, friendName) {
    currentChatFriendUid = friendUid;
    currentChatFriendName = friendName;
    document.getElementById('chat-friend-name').textContent = friendName;
    document.getElementById('no-chat-selected').style.display = 'none';
    document.getElementById('active-chat').style.display = 'flex';
    document.getElementById('messages-container').innerHTML =
      '<div class="empty-state" style="font-style:normal;">Loading messages...</div>';
    // Tell the extension to start listening to this DM room
    vscode.postMessage({ type: 'openChat', friendUid: friendUid, friendName: friendName });
    // Switch to chat tab
    switchTab('chat');
  }

  // ── Close Chat ──
  function closeChat() {
    currentChatFriendUid = null;
    currentChatFriendName = '';
    document.getElementById('no-chat-selected').style.display = 'flex';
    document.getElementById('active-chat').style.display = 'none';
  }

  // ── Send Message ──
  function sendMsg() {
    if (!currentChatFriendUid) return;
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'sendMessage', text: text, friendUid: currentChatFriendUid });
    input.value = '';
  }

  document.getElementById('chat-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
  });

  // ── Show Action Result Toast ──
  function showActionResult(success, message) {
    const el = document.getElementById('action-result');
    el.textContent = message;
    el.className = 'action-result ' + (success ? 'success' : 'error');
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  // ═══════════════════════════════════════════════════════════════
  // MESSAGE HANDLER — receives data from the extension
  // ═══════════════════════════════════════════════════════════════
  window.addEventListener('message', function(event) {
    const msg = event.data;

    if (msg.type === 'loginSuccess') {
      myUserId = msg.userId;
      myPingCode = msg.pingCode || '---';
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('app-screen').style.display = 'flex';
      document.getElementById('my-name').textContent = msg.userName;
      document.getElementById('my-ping-code').textContent = myPingCode;
      const avatar = document.getElementById('my-avatar');
      if (msg.photoURL) { avatar.src = msg.photoURL; avatar.style.display = 'block'; }
    }

    if (msg.type === 'logout') {
      document.getElementById('login-screen').style.display = 'flex';
      document.getElementById('app-screen').style.display = 'none';
      myUserId = null;
      myPingCode = '';
      friendUids = new Set();
      currentChatFriendUid = null;
    }

    if (msg.type === 'friendsListUpdate') {
      friendUids = new Set(msg.friendUids || []);
      updatePresenceUI();
      updateFriendsListUI();
    }

    if (msg.type === 'presenceUpdate') {
      presenceData = msg.data || {};
      updatePresenceUI();
      updateFriendsListUI();
    }

    if (msg.type === 'friendRequestsUpdate') {
      updateRequestsUI(msg.data);
    }

    if (msg.type === 'friendActionResult') {
      showActionResult(msg.success, msg.message);
    }

    if (msg.type === 'messageUpdate') {
      if (msg.friendUid === currentChatFriendUid) {
        updateMessagesUI(msg.data);
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // UI UPDATE FUNCTIONS
  // ═══════════════════════════════════════════════════════════════

  // ── Update Presence List (Online tab — friends only) ──
  function updatePresenceUI() {
    const container = document.getElementById('presence-list');

    if (!presenceData || friendUids.size === 0) {
      container.innerHTML = '<div class="empty-state">Add some friends to see who\\'s online!</div>';
      return;
    }

    // Filter to friends only and sort: active > idle > offline
    const friendEntries = Object.entries(presenceData)
      .filter(([uid]) => friendUids.has(uid))
      .sort((a, b) => {
        const order = { active: 0, idle: 1, offline: 2 };
        return (order[a[1].status] || 2) - (order[b[1].status] || 2);
      });

    if (friendEntries.length === 0) {
      container.innerHTML = '<div class="empty-state">None of your friends are online yet.</div>';
      return;
    }

    container.innerHTML = friendEntries.map(([uid, user]) => {
      const dotClass = 'dot-' + (user.status || 'offline');
      const emoji = user.status === 'active' ? '⚡' : user.status === 'idle' ? '🌙' : '';
      const fileInfo = user.currentFile
        ? '<div class="presence-file">📄 ' + escapeHtml(user.currentFile) + '</div>'
        : '<div class="presence-file">' + (user.status === 'offline' ? 'Offline' : '') + '</div>';
      const photoSrc = user.photoURL || '';

      return \`
        <div class="presence-item" onclick="openChat('\${uid}', '\${escapeHtml(user.name)}')">
          <div class="presence-avatar-wrap">
            <img class="presence-avatar" src="\${escapeHtml(photoSrc)}" alt="\${escapeHtml(user.name)}"
              onerror="this.src=''; this.style.background='#555'">
            <div class="presence-status-dot \${dotClass}"></div>
          </div>
          <div class="presence-info">
            <div class="presence-name">\${emoji} \${escapeHtml(user.name)}</div>
            \${fileInfo}
          </div>
          <span class="chat-hint">💬</span>
        </div>
      \`;
    }).join('');
  }

  // ── Update Friends List (Friends tab) ──
  function updateFriendsListUI() {
    const container = document.getElementById('friends-list');

    if (friendUids.size === 0) {
      container.innerHTML = '<div class="empty-state">Add friends using their Ping Code!</div>';
      return;
    }

    // Show all friends with their current status from presence data
    const html = Array.from(friendUids).map(uid => {
      const p = presenceData[uid];
      const name = p ? p.name : 'Friend';
      const status = p ? p.status : 'offline';
      const dotClass = 'dot-' + status;
      const photoSrc = p && p.photoURL ? p.photoURL : '';
      const statusText = status === 'active' ? '🟢 Active' : status === 'idle' ? '🟡 Idle' : '⚫ Offline';

      return \`
        <div class="presence-item" onclick="openChat('\${uid}', '\${escapeHtml(name)}')">
          <div class="presence-avatar-wrap">
            <img class="presence-avatar" src="\${escapeHtml(photoSrc)}" alt="\${escapeHtml(name)}"
              onerror="this.src=''; this.style.background='#555'">
            <div class="presence-status-dot \${dotClass}"></div>
          </div>
          <div class="presence-info">
            <div class="presence-name">\${escapeHtml(name)}</div>
            <div class="presence-file">\${statusText}</div>
          </div>
          <span class="chat-hint">💬</span>
        </div>
      \`;
    }).join('');

    container.innerHTML = html;
  }

  // ── Update Pending Requests ──
  function updateRequestsUI(requests) {
    const container = document.getElementById('requests-list');
    const badge = document.getElementById('requests-badge');

    if (!requests || Object.keys(requests).length === 0) {
      container.innerHTML = '<div class="empty-state">No pending requests</div>';
      badge.style.display = 'none';
      return;
    }

    const entries = Object.entries(requests);
    badge.textContent = entries.length.toString();
    badge.style.display = 'inline-block';

    container.innerHTML = entries.map(([uid, req]) => {
      const photoSrc = req.fromPhoto || '';
      return \`
        <div class="request-item">
          <img class="request-avatar" src="\${escapeHtml(photoSrc)}" alt="\${escapeHtml(req.from)}"
            onerror="this.src=''; this.style.background='#555'">
          <div class="request-info">
            <div class="request-name">\${escapeHtml(req.from)}</div>
            <div class="request-code">\${escapeHtml(req.fromCode)}</div>
          </div>
          <div class="request-actions">
            <button class="btn-accept" onclick="acceptReq('\${uid}')">Accept</button>
            <button class="btn-decline" onclick="declineReq('\${uid}')">Decline</button>
          </div>
        </div>
      \`;
    }).join('');
  }

  // ── Update Messages (DM) ──
  function updateMessagesUI(data) {
    const container = document.getElementById('messages-container');

    if (!data || Object.keys(data).length === 0) {
      container.innerHTML = '<div class="empty-state" style="font-style:normal;">No messages yet. Say hi! 👋</div>';
      return;
    }

    // Sort by timestamp
    const messages = Object.values(data).sort((a, b) => {
      const tA = a.timestamp ? (typeof a.timestamp === 'number' ? a.timestamp : 0) : 0;
      const tB = b.timestamp ? (typeof b.timestamp === 'number' ? b.timestamp : 0) : 0;
      return tA - tB;
    });

    const recent = messages.slice(-100);

    container.innerHTML = recent.map(msg => {
      const isMe = msg.sender === myUserId;
      const timeStr = msg.timestamp ? formatTime(msg.timestamp) : '';
      const photoSrc = msg.photoURL || '';

      return \`
        <div class="message" style="\${isMe ? 'background: rgba(0,120,212,0.07); border-radius:6px;' : ''}">
          <img class="msg-avatar" src="\${escapeHtml(photoSrc)}" alt="\${escapeHtml(msg.name)}"
            onerror="this.src=''; this.style.background='#555'">
          <div class="msg-body">
            <div class="msg-header">
              <span class="msg-name" style="\${isMe ? 'color:#4fc3f7;' : ''}">\${escapeHtml(msg.name)}</span>
              <span class="msg-time">\${timeStr}</span>
            </div>
            <div class="msg-text">\${escapeHtml(msg.text)}</div>
          </div>
        </div>
      \`;
    }).join('');

    container.scrollTop = container.scrollHeight;
  }

  // ── Utilities ──
  function formatTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
</script>
</body>
</html>`;
  }
}
