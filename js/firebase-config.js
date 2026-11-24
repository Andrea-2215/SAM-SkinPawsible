import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyBMdrb9XsoLrtTPyfngw7MHLi3eiHsJZYM",
  authDomain: "skinpawsible.firebaseapp.com",
  databaseURL: "https://skinpawsible-default-rtdb.firebaseio.com",
  projectId: "skinpawsible",
  storageBucket: "skinpawsible.firebasestorage.app",
  messagingSenderId: "554494330723",
  appId: "1:554494330723:web:fba6ecd9ffee752ad9b556"
};

// Initialize Firebase App
const app = initializeApp(firebaseConfig);

// Initialize & Export Authentication and Firestore Services
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
