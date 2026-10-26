
import { initializeApp } from
  "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";

import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

import {
  getFirestore, doc, getDoc, collection, addDoc,
  getDocs, query, orderBy, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

import {
  getStorage, ref, uploadBytesResumable, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js";

// Firebase Console → Project settings → Your apps থেকে তথ্য বসান।
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_STORAGE_BUCKET",
  appId: "YOUR_APP_ID"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

const $ = id => document.getElementById(id);

let activeAdmin = null;
let busy = false;

function message(id, text) {
  $(id).textContent = text;
}

function safeText(value) {
  return String(value ?? "");
}

// Firestore admins/{uid} ডকুমেন্টে active: true থাকলেই
// এই UI-তে Admin Dashboard দেখানো হবে.
// প্রকৃত নিরাপত্তা Firestore/Storage Rules-এও লাগবে.
async function isAuthorized(user) {
  const snap = await getDoc(doc(db, "admins", user.uid));
  return snap.exists() && snap.data().active === true;
}

function showDashboard(allowed) {
  $("loginSection").hidden = allowed;
  $("dashboard").hidden = !allowed;
}

onAuthStateChanged(auth, async user => {
  showDashboard(false);
  activeAdmin = null;

  if (!user) return;

  try {
    if (!(await isAuthorized(user))) {
      await signOut(auth);
      message("loginMessage", "এই অ্যাকাউন্ট Admin হিসেবে অনুমোদিত নয়।");
      return;
    }

    activeAdmin = user;
    showDashboard(true);
    await loadVideos();
  } catch (error) {
    message("loginMessage", "Firebase সেটআপ বা অনুমতি পরীক্ষা করুন: " + error.message);
  }
});

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  message("loginMessage", "Logging in...");

  try {
    await signInWithEmailAndPassword(
      auth,
      $("email").value.trim(),
      $("password").value
    );
  } catch (error) {
    message("loginMessage", "Login failed: " + error.message);
  }
});

$("logoutBtn").addEventListener("click", () => signOut(auth));

function checkFile(file, allowedTypes, maxBytes) {
  if (!file) return;
  if (!allowedTypes.includes(file.type)) {
    throw new Error("এই ফাইল ফরম্যাট অনুমোদিত নয়।");
  }
  if (file.size > maxBytes) {
    throw new Error("ফাইলটি নির্ধারিত সীমার চেয়ে বড়।");
  }
}

function uploadFile(file, path, onProgress) {
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(ref(storage, path), file);

    task.on("state_changed",
      snapshot => {
        onProgress(snapshot.totalBytes
          ? snapshot.bytesTransferred / snapshot.totalBytes * 100
          : 0);
      },
      reject,
      async () => {
        try {
          resolve({
            url: await getDownloadURL(task.snapshot.ref),
            path
          });
        } catch (error) {
          reject(error);
        }
      }
    );
  });
}

$("uploadForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || !activeAdmin) return;

  busy = true;
  $("uploadBtn").disabled = true;
  message("uploadMessage", "Checking files...");

  let videoPath = "";
  let posterPath = "";

  try {
    if (!(await isAuthorized(activeAdmin))) {
      throw new Error("Admin অনুমতি আর সক্রিয় নেই।");
    }

    const title = $("title").value.trim();
    const category = $("category").value;
    const description = $("description").value.trim();
    const video = $("video").files[0];
    const poster = $("poster").files[0];

    if (!title || !video) throw new Error("Title ও Video আবশ্যক।");

    // সীমা উদাহরণস্বরূপ 300 MB; আপনার Storage quota যাচাই করুন।
    checkFile(video,
      ["video/mp4", "video/webm", "video/quicktime"],
      300 * 1024 * 1024);

    checkFile(poster,
      ["image/jpeg", "image/png", "image/webp"],
      5 * 1024 * 1024);

    const id = crypto.randomUUID();
    videoPath = `videos/${activeAdmin.uid}/${id}/video`;
    message("uploadMessage", "Uploading video...");

    const uploadedVideo = await uploadFile(video, videoPath, percent => {
      $("progressBar").style.width = percent + "%";
      message("uploadMessage", `Video upload: ${Math.round(percent)}%`);
    });

    let uploadedPoster = null;

    if (poster) {
      posterPath = `videos/${activeAdmin.uid}/${id}/poster`;
      uploadedPoster = await uploadFile(poster, posterPath, () => {});
    }

    await addDoc(collection(db, "videos"), {
      title,
      category,
      description,
      videoUrl: uploadedVideo.url,
      videoPath: uploadedVideo.path,
      posterUrl: uploadedPoster?.url || "",
      posterPath: uploadedPoster?.path || "",
      ownerUid: activeAdmin.uid,
      published: false,
      createdAt: serverTimestamp()
    });

    $("uploadForm").reset();
    $("progressBar").style.width = "0%";
    message("uploadMessage", "Upload complete. Video saved as unpublished.");
    await loadVideos();

  } catch (error) {
    message("uploadMessage", "Error: " + error.message);
  } finally {
    busy = false;
    $("uploadBtn").disabled = false;
  }
});

async function loadVideos() {
  if (!activeAdmin) return;

  const list = $("videoList");
  list.replaceChildren();

  const q = query(collection(db, "videos"), orderBy("createdAt", "desc"));
  const result = await getDocs(q);
  let count = 0;

  result.forEach(snapshot => {
    const data = snapshot.data();

    // Admin-কে শুধু নিজের তৈরি ভিডিও দেখানো হবে।
    if (data.ownerUid !== activeAdmin.uid) return;

    count++;
    const card = document.createElement("article");
    card.className = "video-card";

    const heading = document.createElement("h3");
    heading.textContent = safeText(data.title);

    const info = document.createElement("p");
    info.textContent =
      `${safeText(data.category)} · ${data.published ? "Published" : "Unpublished"}`;

    const toggle = document.createElement("button");
    toggle.textContent = data.published ? "UNPUBLISH" : "PUBLISH";
    toggle.addEventListener("click", async () => {
      message("uploadMessage", "Publish status পরিবর্তনের জন্য নিরাপদ backend action দরকার।");
    });

    const remove = document.createElement("button");
    remove.className = "secondary";
    remove.textContent = "DELETE";
    remove.addEventListener("click", async () => {
      if (!confirm("এই ভিডিওর রেকর্ড মুছবেন?")) return;
      try {
        await deleteDoc(doc(db, "videos", snapshot.id));
        // Storage file delete করার জন্যও সঠিক Rules ও path লাগবে।
        await loadVideos();
      } catch (error) {
        message("uploadMessage", "Delete failed: " + error.message);
      }
    });

    card.append(heading, info, toggle, remove);
    list.append(card);
  });

  $("videoCount").textContent = String(count);
  if (!count) list.textContent = "এখনও কোনো ভিডিও নেই।";
}
