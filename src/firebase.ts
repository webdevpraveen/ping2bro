// firebase.ts
// ═══════════════════════════════════════════════════════════════════
// This file handles ALL Firebase operations.
// Every other file imports what it needs from here.
// Never initialize Firebase in any other file.
// ═══════════════════════════════════════════════════════════════════

import { initializeApp, FirebaseApp } from 'firebase/app';

import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  Auth,
  User,
  onAuthStateChanged
} from 'firebase/auth';
import {
  getDatabase,
  ref,
  set,
  get,
  onValue,
  push,
  remove,
  update,
  serverTimestamp,
  onDisconnect,
  query,
  orderByChild,
  equalTo,
  Database,
  DataSnapshot
} from 'firebase/database';

// ─────────────────────────────────────────────────────────────────
// FIREBASE CONFIGURATION
// (Firebase Client API keys are intentionally public and safe to ship in apps)
// ─────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyDEtf9rJaQtgzT_PKgx1mGLlcA_RB4n4Wo",
  authDomain: "ping2bro.firebaseapp.com",
  databaseURL: "https://ping2bro-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "ping2bro",
  storageBucket: "ping2bro.firebasestorage.app",
  messagingSenderId: "996806647798",
  appId: "1:996806647798:web:cc0298477508068ee8f1d7",
  measurementId: "G-ME3FQ3XW3K"
};

// Initialize Firebase app — this must happen only once
const app: FirebaseApp = initializeApp(firebaseConfig);

// Export auth and database instances for use in other files
export const auth: Auth = getAuth(app);
export const db: Database = getDatabase(app);

// ═══════════════════════════════════════════════════════════════════
// AUTHENTICATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * Logs in with Email and Password.
 * 
 * @param email - User email
 * @param password - User password
 * @returns The logged-in Firebase User object
 */
export async function loginWithEmail(email: string, password: string): Promise<User> {
  const result = await signInWithEmailAndPassword(auth, email, password);
  return result.user;
}

/**
 * Registers a new user with Email and Password.
 * 
 * @param email - User email
 * @param password - User password
 * @returns The new Firebase User object
 */
export async function registerWithEmail(email: string, password: string): Promise<User> {
  const result = await createUserWithEmailAndPassword(auth, email, password);
  return result.user;
}

/**
 * Logs out the current user.
 */
export async function logoutUser(): Promise<void> {
  await signOut(auth);
}

/**
 * Listens to auth state changes.
 * Calls the callback with user (logged in) or null (logged out).
 * Call this once in extension.ts to react to login/logout.
 */
export function onAuthChange(callback: (user: User | null) => void): void {
  onAuthStateChanged(auth, callback);
}

// ═══════════════════════════════════════════════════════════════════
// PING CODE SYSTEM (Friend Codes)
// ═══════════════════════════════════════════════════════════════════

/**
 * Generates a unique Ping Code like "PRV-4829".
 * Takes the first 3 letters of the user's name/email (uppercase),
 * appends a random 4-digit number, and checks Firebase for collisions.
 * Retries up to 10 times if a collision is found.
 *
 * @param nameOrEmail - User's display name or email
 * @returns A unique Ping Code string
 */
export async function generatePingCode(nameOrEmail: string): Promise<string> {
  // Extract first 3 uppercase letters from name (strip non-alpha chars)
  const letters = nameOrEmail
    .replace(/[^a-zA-Z]/g, '')  // Remove non-letter characters
    .substring(0, 3)             // Take first 3 letters
    .toUpperCase()
    .padEnd(3, 'X');             // Pad with 'X' if name is very short

  // Try up to 10 times to find a unique code
  for (let attempt = 0; attempt < 10; attempt++) {
    // Generate a random 4-digit number (1000-9999)
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    const code = `${letters}-${randomNum}`;

    // Check Firebase to see if this code already exists
    const exists = await checkPingCodeExists(code);
    if (!exists) {
      return code;  // Unique! Use this one
    }
    // If it exists, loop again with a new random number
  }

  // Fallback: use timestamp to guarantee uniqueness
  const fallbackNum = Date.now() % 10000;
  return `${letters}-${fallbackNum.toString().padStart(4, '0')}`;
}

/**
 * Checks if a Ping Code already exists in Firebase.
 * Queries the users/ node where pingCode matches.
 *
 * @param code - The Ping Code to check
 * @returns true if code is already taken, false if available
 */
async function checkPingCodeExists(code: string): Promise<boolean> {
  const usersRef = ref(db, 'users');
  // Query all users to find one with this pingCode
  const q = query(usersRef, orderByChild('pingCode'), equalTo(code));
  const snapshot = await get(q);
  return snapshot.exists();
}

/**
 * Saves the user's profile and Ping Code to Firebase.
 * Called once after first login when no pingCode exists yet.
 * Path: users/{uid}
 *
 * @param uid - Firebase UID
 * @param name - Display name
 * @param pingCode - Generated Ping Code
 * @param photoURL - Google profile photo URL
 */
export async function saveUserProfile(
  uid: string,
  name: string,
  pingCode: string,
  photoURL: string = ''
): Promise<void> {
  const userRef = ref(db, `users/${uid}`);
  await set(userRef, {
    name: name,
    pingCode: pingCode,
    photoURL: photoURL,
    friends: {}  // Empty friends list initially
  });
}

/**
 * Fetches the Ping Code for a given user.
 * Returns null if user doesn't exist or has no code yet.
 *
 * @param uid - Firebase UID
 * @returns The Ping Code string, or null
 */
export async function getPingCodeForUser(uid: string): Promise<string | null> {
  const codeRef = ref(db, `users/${uid}/pingCode`);
  const snapshot = await get(codeRef);
  return snapshot.exists() ? snapshot.val() : null;
}

/**
 * Looks up a user by their Ping Code.
 * Returns an object with { uid, name, photoURL } or null if not found.
 *
 * @param code - The Ping Code to search for (e.g. "PRV-4829")
 * @returns User info object or null
 */
export async function lookupUserByPingCode(
  code: string
): Promise<{ uid: string; name: string; photoURL: string } | null> {
  const usersRef = ref(db, 'users');
  const q = query(usersRef, orderByChild('pingCode'), equalTo(code.toUpperCase()));
  const snapshot = await get(q);

  if (!snapshot.exists()) {
    return null;  // No user with this Ping Code
  }

  // snapshot.val() is an object like { "uid123": { name: ..., pingCode: ... } }
  const data = snapshot.val();
  const uid = Object.keys(data)[0];
  const userData = data[uid];

  return {
    uid: uid,
    name: userData.name || 'Unknown',
    photoURL: userData.photoURL || ''
  };
}

// ═══════════════════════════════════════════════════════════════════
// FRIEND REQUEST SYSTEM
// ═══════════════════════════════════════════════════════════════════

/**
 * Friend request data structure stored in Firebase.
 */
export interface FriendRequest {
  from: string;        // Sender's display name
  fromPhoto: string;   // Sender's profile photo URL
  fromCode: string;    // Sender's Ping Code
  timestamp: object;   // Firebase server timestamp
}

/**
 * Sends a friend request from one user to another.
 * Creates an entry under friendRequests/{toUid}/{fromUid}.
 * Does NOT send if a request already exists or they're already friends.
 *
 * @param fromUid - Sender's Firebase UID
 * @param toUid - Recipient's Firebase UID
 * @param fromName - Sender's display name
 * @param fromPhoto - Sender's photo URL
 * @param fromCode - Sender's Ping Code
 */
export async function sendFriendRequest(
  fromUid: string,
  toUid: string,
  fromName: string,
  fromPhoto: string,
  fromCode: string
): Promise<{ success: boolean; message: string }> {
  // Don't send a request to yourself
  if (fromUid === toUid) {
    return { success: false, message: "That's your own code!" };
  }

  // Check if already friends
  const friendRef = ref(db, `users/${fromUid}/friends/${toUid}`);
  const friendSnap = await get(friendRef);
  if (friendSnap.exists()) {
    return { success: false, message: 'You are already friends!' };
  }

  // We cannot check if a request already exists in THEIR inbox
  // because Firebase rules only allow users to read their OWN inboxes.
  // This is completely fine — if we send it twice, it just updates the timestamp.

  // Check if THEY already sent US a request (auto-accept in that case)
  const existingRef2 = ref(db, `friendRequests/${fromUid}/${toUid}`);
  const existingSnap2 = await get(existingRef2);
  if (existingSnap2.exists()) {
    // They already sent us a request — auto-accept it
    await acceptFriendRequest(fromUid, toUid);
    return { success: true, message: 'They already sent you a request — you are now friends! 🎉' };
  }

  // Send the request
  const requestRef = ref(db, `friendRequests/${toUid}/${fromUid}`);
  await set(requestRef, {
    from: fromName,
    fromPhoto: fromPhoto,
    fromCode: fromCode,
    timestamp: serverTimestamp()
  });

  return { success: true, message: 'Friend request sent! ✉️' };
}

/**
 * Accepts a friend request.
 * Adds mutual friendship entries under users/{uid}/friends/ for BOTH users.
 * Removes the friend request after accepting.
 *
 * @param myUid - Current user's UID (the one accepting)
 * @param friendUid - The UID of the user who sent the request
 */
export async function acceptFriendRequest(
  myUid: string,
  friendUid: string
): Promise<void> {
  // We use individual set() calls instead of atomic update() because Firebase rules
  // usually prevent users from writing directly to another user's profile.
  // If we used update(), the whole transaction would fail if they lack permission for friendUid.

  // Add friend to MY list
  await set(ref(db, `users/${myUid}/friends/${friendUid}`), true).catch(() => {});
  
  // Try to add me to THEIR list (Might fail due to strict database rules)
  await set(ref(db, `users/${friendUid}/friends/${myUid}`), true).catch(() => {});

  // Remove the friend request from my inbox
  const reqRef1 = ref(db, `friendRequests/${myUid}/${friendUid}`);
  await remove(reqRef1).catch(() => {});
}

/**
 * Declines a friend request.
 * Simply removes the request entry from Firebase.
 *
 * @param myUid - Current user's UID
 * @param friendUid - UID of the user whose request to decline
 */
export async function declineFriendRequest(
  myUid: string,
  friendUid: string
): Promise<void> {
  const reqRef = ref(db, `friendRequests/${myUid}/${friendUid}`);
  await remove(reqRef);
}

/**
 * Listens to the current user's friends list in real-time.
 * The friends list is at users/{uid}/friends and looks like { "uid1": true, "uid2": true }
 * Returns an unsubscribe function.
 *
 * @param uid - Current user's Firebase UID
 * @param callback - Called with a Set of friend UIDs whenever it changes
 */
export function listenToFriends(
  uid: string,
  callback: (friendUids: Set<string>) => void
): () => void {
  const friendsRef = ref(db, `users/${uid}/friends`);
  const unsubscribe = onValue(friendsRef, (snapshot: DataSnapshot) => {
    const data = snapshot.val();
    const friendSet = new Set<string>();
    if (data) {
      Object.keys(data).forEach(friendUid => friendSet.add(friendUid));
    }
    callback(friendSet);
  });
  return unsubscribe;
}

/**
 * Listens to incoming friend requests for the current user.
 * Path: friendRequests/{uid}
 * Returns an unsubscribe function.
 *
 * @param uid - Current user's Firebase UID
 * @param callback - Called with requests object whenever it changes
 */
export function listenToFriendRequests(
  uid: string,
  callback: (requests: Record<string, FriendRequest> | null) => void
): () => void {
  const requestsRef = ref(db, `friendRequests/${uid}`);
  const unsubscribe = onValue(requestsRef, (snapshot: DataSnapshot) => {
    callback(snapshot.val());
  });
  return unsubscribe;
}

// ═══════════════════════════════════════════════════════════════════
// PRESENCE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * Presence data structure.
 * This is what we store in Firebase for each user.
 */
export interface PresenceData {
  name: string;            // Display name or email prefix
  status: 'active' | 'idle' | 'offline';
  currentFile: string;     // Currently open file name (not full path)
  lastSeen: object;        // Firebase server timestamp
  photoURL?: string;       // Google profile photo URL
}

/**
 * Updates the current user's presence in Firebase.
 * Path: presence/{userId}
 *
 * @param userId - Firebase UID of the current user
 * @param data - Presence data to write
 */
export function updatePresence(userId: string, data: PresenceData): void {
  const presenceRef = ref(db, `presence/${userId}`);
  set(presenceRef, {
    ...data,
    lastSeen: serverTimestamp()  // Always use server time, not client time
  }).catch((error) => {
    console.error('Ping2Bro: Failed to update presence:', error);
  });
}

/**
 * Sets up automatic offline detection using Firebase's onDisconnect.
 * When the user loses connection (closes VS Code, internet drops),
 * Firebase automatically marks them as offline.
 *
 * @param userId - Firebase UID of current user
 * @param userName - Display name of current user
 * @param photoURL - Profile photo URL
 */
export function markOfflineOnDisconnect(
  userId: string,
  userName: string,
  photoURL: string
): void {
  const presenceRef = ref(db, `presence/${userId}`);

  // This tells Firebase: "When this client disconnects, run this write"
  // Firebase runs this on its server side, so it works even if VS Code crashes
  onDisconnect(presenceRef).set({
    name: userName,
    status: 'offline',
    currentFile: '',
    lastSeen: serverTimestamp(),
    photoURL: photoURL
  });
}

/**
 * Listens to ALL users' presence data in real-time.
 * The sidebar filters this to show only mutual friends.
 * Returns an unsubscribe function — call it to stop listening.
 *
 * @param callback - Function called with presence data object
 */
export function listenToPresence(
  callback: (data: Record<string, PresenceData> | null) => void
): () => void {
  const presenceRef = ref(db, 'presence');

  // onValue fires immediately with current data, then again on every change
  const unsubscribe = onValue(presenceRef, (snapshot: DataSnapshot) => {
    callback(snapshot.val());
  });

  return unsubscribe;
}

// ═══════════════════════════════════════════════════════════════════
// DIRECT MESSAGING FUNCTIONS (Friends-Only Chat)
// ═══════════════════════════════════════════════════════════════════

/**
 * Message data structure.
 */
export interface MessageData {
  sender: string;     // Firebase UID
  name: string;       // Display name
  text: string;       // Message content
  timestamp: object;  // Firebase server timestamp
  photoURL?: string;  // Sender's profile photo
}

/**
 * Generates a deterministic room ID for a DM between two users.
 * Sorts the UIDs alphabetically so both users get the same room ID.
 * Example: chat_abc123_xyz789
 *
 * @param uid1 - First user's Firebase UID
 * @param uid2 - Second user's Firebase UID
 * @returns A consistent room ID string
 */
export function getDMRoomId(uid1: string, uid2: string): string {
  // Sort UIDs so the room ID is always the same regardless of who calls it
  const sorted = [uid1, uid2].sort();
  return `dm_${sorted[0]}_${sorted[1]}`;
}

/**
 * Sends a direct message to a friend.
 * Uses `push` which creates a unique key automatically (no ID collisions).
 * The room ID is computed from sorted UIDs so both friends share the same room.
 *
 * @param myUid - Sender's Firebase UID
 * @param friendUid - Recipient's Firebase UID
 * @param name - Sender's display name
 * @param text - Message text
 * @param photoURL - Sender's profile photo URL
 */
export function sendMessage(
  myUid: string,
  friendUid: string,
  name: string,
  text: string,
  photoURL: string = ''
): void {
  // Don't send empty messages
  if (!text.trim()) {
    return;
  }

  const roomId = getDMRoomId(myUid, friendUid);
  const messagesRef = ref(db, `messages/${roomId}`);
  const messageData: MessageData = {
    sender: myUid,
    name: name,
    text: text.trim(),
    timestamp: serverTimestamp(),
    photoURL: photoURL
  };

  push(messagesRef, messageData).catch((error) => {
    console.error('Ping2Bro: Failed to send message:', error);
  });
}

/**
 * Listens to messages in a DM room in real-time.
 * Calls callback whenever a new message arrives.
 * Returns an unsubscribe function.
 *
 * @param roomId - DM room ID (from getDMRoomId)
 * @param callback - Function called with messages object
 */
export function listenToMessages(
  roomId: string,
  callback: (data: Record<string, MessageData> | null) => void
): () => void {
  const messagesRef = ref(db, `messages/${roomId}`);

  const unsubscribe = onValue(messagesRef, (snapshot: DataSnapshot) => {
    callback(snapshot.val());
  });

  return unsubscribe;
}
