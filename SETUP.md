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

The app stores vocabulary, notes, highlights, bookmarks, and reading statistics in `users/{userId}` in Firestore after Google sign-in. Local browser storage remains available when signed out.