// extension.ts
// ═══════════════════════════════════════════════════════════════════
// This is the entry point of the Ping2Bro extension.
// VS Code calls activate() when our extension starts.
// Think of this as the main() function — it sets up everything.
// ═══════════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import {
  loginWithEmail,
  registerWithEmail,
  logoutUser,
  onAuthChange,
  auth,
  getPingCodeForUser,
  generatePingCode,
  saveUserProfile,
  markOfflineOnDisconnect
} from './firebase';
import { startPresenceTracking, stopPresenceTracking, markOfflineNow } from './presence';
import { Ping2BroSidebarProvider } from './sidebar';
import { clearNotificationState } from './notifications';

// Store the sidebar provider globally so commands can interact with it
let sidebarProvider: Ping2BroSidebarProvider;

/**
 * Called by VS Code when the extension activates.
 * This is where we register everything.
 */
export function activate(context: vscode.ExtensionContext): void {
  console.log('Ping2Bro: Extension activated!');

  // ── Register Sidebar Provider ──
  sidebarProvider = new Ping2BroSidebarProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'ping2bro-sidebar',   // Must match the view ID in package.json
      sidebarProvider,
      {
        // Keep the webview alive even when not visible
        // This ensures we don't miss notifications or real-time updates
        webviewOptions: { retainContextWhenHidden: true }
      }
    )
  );

  // ── Auto Login ──
  // Firebase Node.js uses in-memory persistence, so users log out on restart.
  // We use VS Code's secure SecretStorage to auto-login.
  const performAutoLogin = async () => {
    try {
      const email = await context.secrets.get('ping2bro.email');
      const password = await context.secrets.get('ping2bro.password');
      if (email && password) {
        console.log('Ping2Bro: Attempting auto-login...');
        await loginWithEmail(email, password);
      }
    } catch (e) {
      console.log('Ping2Bro: Auto-login failed, clearing secrets.');
      await context.secrets.delete('ping2bro.email');
      await context.secrets.delete('ping2bro.password');
    }
  };
  performAutoLogin();

  // ── Listen to Auth State ──
  // This fires whenever user logs in or logs out
  onAuthChange(async (user) => {
    if (user) {
      try {
        // User just logged in (or was already logged in from previous session)
        const emailPrefix = user.email ? user.email.split('@')[0] : 'Developer';
        const displayName = user.displayName || emailPrefix;
        console.log('Ping2Bro: User logged in:', displayName);

        const photoURL = user.photoURL || '';

        // Check if user already has a Ping Code
        let pingCode = await getPingCodeForUser(user.uid);
        
        // If no Ping Code (first time login), generate and save one
        if (!pingCode) {
          console.log('Ping2Bro: First login detected, generating Ping Code...');
          pingCode = await generatePingCode(displayName);
          await saveUserProfile(user.uid, displayName, pingCode, photoURL);
          console.log('Ping2Bro: Ping Code generated:', pingCode);
        }

        // Update sidebar UI
        sidebarProvider.notifyLogin(displayName, photoURL, user.uid, pingCode);

        // Start tracking activity
        startPresenceTracking(user.uid, displayName, photoURL);

        // Set up automatic offline on disconnect (Firebase handles this server-side)
        markOfflineOnDisconnect(user.uid, displayName, photoURL);

        // Show status bar item
        updateStatusBar(true, displayName);
      } catch (err: any) {
        console.error('Ping2Bro Initialize Error:', err);
        vscode.window.showErrorMessage('Ping2Bro Error setting up profile: ' + (err.message || 'Unknown error. Check database rules.'));
      }
    } else {
      // User logged out
      console.log('Ping2Bro: User logged out');
      stopPresenceTracking();
      clearNotificationState();
      sidebarProvider.notifyLogout();
      updateStatusBar(false, '');
    }
  });

  // ── Register: Login Command ──
  const loginCommand = vscode.commands.registerCommand(
    'ping2bro.login',
    async () => {
      try {
        const email = await vscode.window.showInputBox({ 
          prompt: 'Ping2Bro Login: Enter your email', 
          placeHolder: 'coder@example.com' 
        });
        if (!email) return;

        const password = await vscode.window.showInputBox({ 
          prompt: 'Ping2Bro Login: Enter your password', 
          password: true 
        });
        if (!password) return;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Ping2Bro: Signing in...',
            cancellable: false
          },
          async () => {
            await loginWithEmail(email, password);
            // Save to secrets for auto-login
            await context.secrets.store('ping2bro.email', email);
            await context.secrets.store('ping2bro.password', password);
          }
        );
      } catch (error: any) {
        console.error('Ping2Bro login error:', error);
        vscode.window.showErrorMessage(
          `Ping2Bro: Login failed — ${error.message || 'Unknown error'}`
        );
      }
    }
  );

  // ── Register: Register Command ──
  const registerCommand = vscode.commands.registerCommand(
    'ping2bro.register',
    async () => {
      try {
        const email = await vscode.window.showInputBox({ 
          prompt: 'Ping2Bro Register: Enter your email', 
          placeHolder: 'coder@example.com' 
        });
        if (!email) return;

        const password = await vscode.window.showInputBox({ 
          prompt: 'Ping2Bro Register: Enter a password (min 6 characters)', 
          password: true 
        });
        if (!password) return;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Ping2Bro: Creating account...',
            cancellable: false
          },
          async () => {
            await registerWithEmail(email, password);
            // Save to secrets for auto-login
            await context.secrets.store('ping2bro.email', email);
            await context.secrets.store('ping2bro.password', password);
          }
        );
      } catch (error: any) {
        console.error('Ping2Bro register error:', error);
        vscode.window.showErrorMessage(
          `Ping2Bro: Registration failed — ${error.message || 'Unknown error'}`
        );
      }
    }
  );

  // ── Register: Logout Command ──
  const logoutCommand = vscode.commands.registerCommand(
    'ping2bro.logout',
    async () => {
      const user = auth.currentUser;
      if (!user) {
        vscode.window.showInformationMessage('Ping2Bro: You are not logged in.');
        return;
      }

      // Mark as offline before logging out
      markOfflineNow();

      // Clear auto-login secrets
      await context.secrets.delete('ping2bro.email');
      await context.secrets.delete('ping2bro.password');

      await logoutUser();
      vscode.window.showInformationMessage('Ping2Bro: Logged out. See you! 👋');
    }
  );

  // ── Register: Show Status Command ──
  const showStatusCommand = vscode.commands.registerCommand(
    'ping2bro.showStatus',
    () => {
      const user = auth.currentUser;
      if (user) {
        vscode.window.showInformationMessage(
          `Ping2Bro: Logged in as ${user.displayName} (${user.email})`
        );
      } else {
        vscode.window.showInformationMessage(
          'Ping2Bro: Not logged in. Run "Ping2Bro: Login with Google" to start.'
        );
      }
    }
  );

  // Register all commands with VS Code's context
  context.subscriptions.push(loginCommand, registerCommand, logoutCommand, showStatusCommand);

  // Register the status bar item
  context.subscriptions.push(statusBarItem);
}

// ─────────────────────────────────────────────────────────────────
// STATUS BAR
// ─────────────────────────────────────────────────────────────────

// Creates a small indicator at the bottom of VS Code showing Ping2Bro status
const statusBarItem = vscode.window.createStatusBarItem(
  vscode.StatusBarAlignment.Right,
  100
);

function updateStatusBar(loggedIn: boolean, userName: string): void {
  if (loggedIn) {
    statusBarItem.text = `$(broadcast) Ping2Bro: ${userName}`;
    statusBarItem.tooltip = 'Ping2Bro is active — Click to see status';
    statusBarItem.command = 'ping2bro.showStatus';
    statusBarItem.color = '#4caf50';  // Green when active
  } else {
    statusBarItem.text = `$(broadcast) Ping2Bro: Click to Login`;
    statusBarItem.tooltip = 'Click to login or register';
    statusBarItem.command = 'ping2bro.login';
    statusBarItem.color = undefined;
  }
  statusBarItem.show();
}

/**
 * Called by VS Code when the extension is deactivated.
 * Clean up everything.
 */
export function deactivate(): void {
  markOfflineNow();
  console.log('Ping2Bro: Extension deactivated.');
}
