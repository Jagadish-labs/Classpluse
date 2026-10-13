# 🎓 ClassPulse — Real-Time College Classroom Platform

> **"One screen that tells a student what to do right now, not just what is happening."**

ClassPulse combines a lightweight Google Classroom with a real-time class status engine and campus events portal for college students and faculty.

---

## ⚡ How to Run

```bash
# 1. Install dependencies
npm install

# 2. Start in Demo Mode (Enables quick-fill login buttons on login page)
npm run demo

# Or start in standard production mode
npm start
```

- **Local Web URL (`/`):** [http://localhost:3000](http://localhost:3000) *(Logged-out visitors see the Public Landing Page; logged-in users enter the App directly)*
- **Direct App URL (`/app`):** [http://localhost:3000/app](http://localhost:3000/app) *(Direct entry to ClassPulse login screen and dashboards)*
- **Direct Landing Page URL (`/landing`):** [http://localhost:3000/landing](http://localhost:3000/landing) *(Direct preview of the public Landing Page even when logged in)*
- **Public Share & QR Page:** [http://localhost:3000/share](http://localhost:3000/share) *(No login needed; large QR code of LAN URL for phone testing)*
- **Admin 90s Pitch Cheat-Sheet:** [http://localhost:3000/demo](http://localhost:3000/demo) *(Admin-only pitch script and reset trigger)*
- **Database:** SQLite (`classpulse.db` auto-initialized and seeded on startup)

---

## 🔑 Demo Login Credentials

| Role | College ID (UID) | Demo Mobile | Default Passkey | Name / Notes |
| :--- | :--- | :--- | :--- | :--- |
| **ADMIN** | `ADMIN001` | `9900000001` | `admin123` | System Administrator (Full campus roster, courses, 5s reset) |
| **FACULTY** | `FAC001` | `9100000001` | `fac123` | Prof. Rao (Data Structures & Software Dev) |
| **FACULTY** | `FAC002` | `9100000002` | `fac123` | Dr. Meena (Data Communications & Networks) |
| **FACULTY** | `FAC003` | `9100000003` | `fac123` | Ms. Kavya (UI/UX Design) |
| **STUDENT** | `STU001` | `9000000001` | `stu123` | Aarav Sharma (Lead Student Organiser, CSE-A) |
| **STUDENT** | `STU002` | `9000000002` | `stu123` | Ananya Iyer (Student, CSE-A) |
| **STUDENT** | `STU007` | `9000000007` | `stu123` | Vikram Malhotra (Attendance shortage `<75%` alert) |
| **SIGNUP DEMO** | `STU101` | `9000000101` | *(not registered)* | Demo Student — roster ID that can still create a passkey |
| **SIGNUP DEMO** | `FAC101` | `9100000101` | *(not registered)* | Demo Faculty — roster ID that can still create a passkey |

---

## ⏱️ 90-Second Demo Pitch Script

1. **00:00 - 00:20 | The Hook — "Right Now" Hero Directive:**
   - Log in as student `STU001` / `stu123`.
   - Show the hero directive telling the student exactly where to go and what to do right now. Show the To-Do list (upcoming assignments) and attendance standing / alerts.
2. **00:20 - 00:45 | Live Status Sync (No Page Reload):**
   - In a second window or phone, log in as faculty `FAC001` / `fac123`.
   - Set class to **Faculty Absent** with note *"Medical leave - study ch 4"*.
   - Student screen updates immediately with audible chime and yellow/red directive without refreshing.
3. **00:45 - 01:10 | Classroom & Instant Return:**
   - Faculty creates an assignment. Student submits answer.
   - Faculty grades the submission (e.g. 96/100) and clicks Return. Student receives instant grade badge and notification bell alert.
4. **01:10 - 01:25 | Campus Life & Live RSVP:**
   - Open Campus Events. Show trending hackathons/workshops. Student clicks Register; available seats decrement live across all devices.
5. **01:25 - 01:30 | 5-Second Demo Reset:**
   - Open Admin tab (or `/demo` cheat-sheet) and click **"Reset Demo Data"**.
   - With a single click and confirmation, all seed data, courses, attendance, marks, events, and classroom items are restored, clearing all statuses and notices in 5 seconds.

---

## 🛡️ Key Features & Endpoints

- **Admin Reset Demo Data:** Restores pristine seed state in `< 500ms` via `/api/admin/reset-demo` and real-time Socket.IO sync.
- **Public `/share` Page:** Zero-auth page rendering high-resolution QR code (generated via `qrcode`), LAN URL, and the tagline *"One screen that tells a student what to do right now."*
- **Admin `/demo` Cheat-Sheet:** Restricted guide (`403` on non-admins) providing login credentials, timeline script, and one-tap reset button.
- **DEMO=1 Quick-Fill:** When launched via `npm run demo`, login page displays one-click buttons to fill demo student (`STU001`) and demo faculty (`FAC001`).
- **Resilience & State Handling:** Friendly empty states on all lists, readable error cards on failed requests, and a sticky *"Reconnecting..."* banner when network connection drops.
- **Security Guards:** Role-enforced routes returning HTTP `403` when students attempt to access faculty or admin endpoints.

---

## 🚀 Deployment Guide

ClassPulse is production-ready and can be deployed with Docker or directly on platforms like **Render** and **Railway**.

### Option 1: Deploy on Render

1. **Push your repository to GitHub**:
   ```bash
   git add .
   git commit -m "ClassPulse production ready"
   git push origin main
   ```
2. **Create a New Web Service on Render**:
   - Go to [dashboard.render.com](https://dashboard.render.com) and click **New + > Web Service**.
   - Connect your GitHub repository (or choose **Blueprint** to auto-load `render.yaml`).
   - Configure settings:
     - **Environment:** `Node` (or Docker)
     - **Build Command:** `npm install`
     - **Start Command:** `npm start`
     - **Health Check Path:** `/healthz`
3. **Set Environment Variables**:
   - `NODE_ENV`: `production`
   - `DEMO`: `1` (enables one-click demo logins for presentations)
   - `SECRET`: Generate a secure random string (e.g. `openssl rand -hex 32`)
   - *(Optional)* `DATA_DIR`: Path to a mounted persistent disk (e.g. `/var/data`)
4. **Deploy**:
   - Click **Create Web Service**. Render builds and starts the application listening on `0.0.0.0` with health checks passing on `/healthz`.

### Option 2: Deploy on Railway

1. **Push your code to GitHub**.
2. **Create New Project on Railway**:
   - Go to [railway.app](https://railway.app) and select **New Project > Deploy from GitHub repo**.
   - Select your repository. Railway automatically detects `Dockerfile` or Node environment.
3. **Set Variables in Railway Dashboard**:
   - `NODE_ENV` = `production`
   - `DEMO` = `1`
   - `SECRET` = `<your-secret-key>`
   - `PORT` = `3000` (or Railway default)
4. **Volume Mount (Optional for Persistent Disk)**:
   - Add a persistent volume mounted at `/app/data` and set `DATA_DIR=/app/data`.

> [!IMPORTANT]
> **Pitch Day Pro-Tip:**
> Free hosting plans on Render and Railway spin down / sleep after periods of inactivity, and ephemeral file storage may reset when dynos restart. **Always open your live site 2 minutes before presenting** to warm up the server, log in as Admin (`ADMIN001` / `admin123`), and tap **"Reset Demo Data"** to ensure pristine demo state!

---

## 📲 Installable App (PWA)

- **Install Prompt:** An "Install App" button automatically surfaces on the login screen on supported mobile and desktop browsers when `beforeinstallprompt` fires.
- **Web App Manifest:** Configured at `/manifest.webmanifest` with theme color `#4f46e5`, standalone display, and 192px/512px responsive icons.
- **Service Worker (`/sw.js`):**
  - Caches the core app shell (`index.html`, `app.js`, `styles.css`, icons) for fast repeat loads.
  - **Zero-Stale-Data API Guarantee:** All `/api/*` and file upload requests strictly bypass cache and use network pass-through so switching accounts or updating live status is never stale.
  - **Offline Fallback Page:** Displays a friendly offline screen (*"You are offline. Reconnect to see live class status."*) when internet drops.

---

## 📈 Impact Dashboard (Pitch ROI)

Located at `#impact` (accessible from the Admin portal and navigation):
- **Status Updates Broadcasted:** Real-time count of directives issued today and this week.
- **Student Time Saved:** Computed as:
  $$\text{Minutes Saved} = (\text{Enrolled Students}) \times (\text{Wait Time Prevented})$$
  *(10 min prevented for Delayed alerts; full class duration, e.g. 50 min, for Absent or Cancelled alerts).*
- **Academic Momentum:** Assignment on-time vs late submissions ratio.
- **Attendance Compliance:** Campus average attendance rate and count of students below the 75% mandatory threshold.
- **Campus Event Funnel:** Live registrations and verified door check-ins via digital QR passes.
- **1-Click Copy Pitch Summary:** Copies a clean 3-line executive summary formatted for pitch slides directly to the clipboard.

---

## 📱 Mobile Number Authentication & Smart Roster

- **Dual-Identifier Login:** Students and faculty can sign in using either their College ID (`UID` like `STU001` or `FAC001`) or their 10-digit mobile number (e.g. `9000000001` or `+919000000001`).
- **Normalized Format:** Accepts 10 digits starting with 6–9, with or without `+91`, spaces, or dashes, and stores normalized as `+91XXXXXXXXXX`.
- **Roster Validation & Signup:** Phone numbers originate strictly from the college roster, maintaining the "only college-approved people" rule. If a roster entry contains a mobile number, the first-time activation form requires that exact number to match.
- **Generic Error Security:** Returns a generic *"Invalid ID/number or passkey"* error on all login and signup failures to prevent phone number or ID enumeration.
- **Strict Privacy Guarantee:** Phone numbers are returned exclusively to the user themselves (in their private profile modal) and to system administrators on the roster management panel. Phone numbers are never exposed in classroom views, attendance, marks, chat messages, or public API endpoints.
- **Admin Roster Management:** Bulk import and manual entry support an optional `phone` column with duplicate and format validation reporting row errors.

> [!WARNING]
> **Fictional Data Notice:**
> All phone numbers in this repository and demo database are strictly **FICTIONAL demo numbers** (`+91 9000000001` to `+91 9000000012`, `+91 9100000001` to `+91 9100000003`, `+91 9900000001`). Real phone numbers must **NEVER** be committed to the repository.

---

## 🗓️ Weekly Timetable & Simulation Engine

- **Comprehensive Weekly Grid:** View weekly period matrices across Monday through Saturday with course codes, titles, room numbers, and faculty details.
- **Visual Status Markers:** Slots dynamically reflect class states (Completed, Live Ongoing, Upcoming, Delayed, Cancelled, or Faculty Absent).
- **Faculty Quick-Directives:** Faculty can update status directly from their timetable view.
- **Simulated Clock Engine:** Built-in demo clock allows presenting timetable directives for any day or period of the week.

---

## 🤖 Contextual AI Academic Assistant

Embedded chat assistant (`#assistant`) tailored with campus data isolation:
- **Student Queries:**
  - *"What is my next class?"* / *"Do I have any free periods today?"*
  - *"How many classes can I miss and keep 75% attendance?"*
  - *"Summarize my day"* / *"Plan my week"* / *"What assignments are due?"*
- **Faculty Queries:**
  - *"What classes do I teach today?"*
  - *"Which students in my courses are at attendance risk?"*
  - *"What submissions are pending grading?"*
- **Privacy & Role Isolation:** Strict access boundaries ensure students only receive their own academic standing and assignments.

---

## 🎨 Enterprise Dashboard Design System

- **Clean Enterprise Aesthetics:** Cohesive Slate/Blue palette (`--slate-50` to `--slate-950`, primary `#2563eb`) with high contrast and readable typography.
- **Tabular Figures:** Numbers in attendance percentages, marks, and timetables use `tabular-nums` for alignment.
- **Responsive Navigation:** Full desktop sidebar with active route states and a sleek bottom navigation bar on mobile devices.
- **Dark Mode Support:** Automatic detection and manual toggle persisted via `localStorage`.

