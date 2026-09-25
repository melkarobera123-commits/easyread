# EasyRead setup

## Local reading features

The app works without an account. Imported books, vocabulary, notes, highlights, bookmarks, and progress stay in the browser's local storage and IndexedDB.

## Enable Google login and sync

1. Create a Firebase project at https://console.firebase.google.com.
2. Add a Web app to the project.
3. Enable **Authentication > Sign-in method > Google**.
4. Create a **Firestore Database** in production or test mode.
5. Copy the Firebase web configuration into `firebase-config.js`.
6. Add `localhost` to **Authentication > Settings > Authorized domains**.
7. Deploy `firestore.rules` to Firestore before making the app public. These rules ensure each signed-in person can access only their own `users/{userId}` record.
8. Enable **Firebase Storage** and deploy `storage.rules` to enable optional backup and restore of original book files.

The app stores vocabulary, notes, highlights, bookmarks, and reading statistics in `users/{userId}` in Firestore after Google sign-in. Local browser storage remains available when signed out.

The Firebase web configuration is intentionally visible to browsers; protect user data with Firestore Security Rules, not by hiding the configuration values.
