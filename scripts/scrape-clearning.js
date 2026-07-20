/**
 * scrape-clearning.js
 * ---------------------------------------------------------------------------
 * Tự động: đăng nhập LMS -> build Class Plan + Class ID Cache -> cào điểm
 * Homework / Book Test / Lesson Quiz theo từng lớp/tuần -> tổng hợp theo Lớp
 * và theo Học viên -> đẩy lên Google Apps Script Web App (Google Sheet).
 *
 * Chạy: node scripts/scrape-clearning.js
 * Cần các biến môi trường (đặt trong GitHub Actions Secrets):
 *   LMS_LOGIN_ID, LMS_LOGIN_PASSWORD   (dùng chung với i-Learning)
 *   CLEARNING_APPS_SCRIPT_URL          (URL Web App riêng cho c-Learning)
 *   CLEARNING_APPS_SCRIPT_TOKEN        (token ghi dữ liệu, đặt trong Script Properties)
 * ---------------------------------------------------------------------------
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const https = require("https");

// Giống i-Learning: job có thể bị hủy đột ngột bất cứ lúc nào, nên checkpoint
// phải tự commit + push ngay trong lúc chạy để không mất tiến độ.
const TIME_BUDGET_MS = 320 * 60 * 1000; // 320 phút cho phần cào điểm
const CACHE_BUILD_BUDGET_MS = 20 * 60 * 1000; // 20 phút cho phần build Class ID Cache

const LOGIN_URL = "https://lms.scotsenglish.edu.vn/login.html";
const BASE = "https://lms.scotsenglish.edu.vn/data/setup.asmx";
const STAFF_ID = 9072;

// Mức trần an toàn (phòng dữ liệu Journal bị lỗi/nhiễu cho ra số Lecture bất
// thường). Số tuần thực tế để cào điểm được xác định từ NGÀY THẬT của
// CounClassInfoJournalList, không còn tính theo Start Date + lịch nữa.
const MAX_WEEK = 30;

// Chi nhánh -> brch_id. Khi mở chi nhánh mới, thêm 1 dòng vào đây.
const BRANCHES = [
  { brch_id: 362, brch_name: "Scots English An Khánh" },
  { brch_id: 387, brch_name: "Scots English Bắc Giang" },
  { brch_id: 382, brch_name: "Scots English Bắc Ninh" },
  { brch_id: 384, brch_name: "Scots English Bắc Ninh 2" },
  { brch_id: 373, brch_name: "Scots English Celadon - Tân Phú" },
  { brch_id: 370, brch_name: "Scots English Đà Nẵng" },
  { brch_id: 371, brch_name: "Scots English Đà Nẵng 2" },
  { brch_id: 366, brch_name: "Scots English Định Công" },
  { brch_id: 361, brch_name: "Scots English Dương Nội" },
  { brch_id: 379, brch_name: "Scots English Hải Dương" },
  { brch_id: 385, brch_name: "Scots English Hải Phòng" },
  { brch_id: 386, brch_name: "Scots English Hải Phòng 2" },
  { brch_id: 353, brch_name: "Scots English Hoàng Đạo Thúy" },
  { brch_id: 348, brch_name: "Scots English Hoàng Quốc Việt" },
  { brch_id: 356, brch_name: "Scots English Kim Giang" },
  { brch_id: 357, brch_name: "Scots English Linh Đàm" },
  { brch_id: 360, brch_name: "Scots English Long Biên" },
  { brch_id: 352, brch_name: "Scots English Mỹ Đình" },
  { brch_id: 358, brch_name: "Scots English Nguyễn Tuân" },
  { brch_id: 359, brch_name: "Scots English Nguyễn Xiển" },
  { brch_id: 365, brch_name: "Scots English Ocean Park" },
  { brch_id: 374, brch_name: "Scots English Phạm Văn Chiêu" },
  { brch_id: 363, brch_name: "Scots English Phạm Văn Đồng" },
  { brch_id: 372, brch_name: "Scots English Phan Văn Trị" },
  { brch_id: 377, brch_name: "Scots English Phúc Yên" },
  { brch_id: 350, brch_name: "Scots English Sài Đồng" },
  { brch_id: 355, brch_name: "Scots English Tây Hồ" },
  { brch_id: 381, brch_name: "Scots English Thái Bình" },
  { brch_id: 369, brch_name: "Scots English Thanh Hóa" },
  { brch_id: 351, brch_name: "Scots English Times City" },
  { brch_id: 368, brch_name: "Scots English Trung Văn" },
  { brch_id: 364, brch_name: "Scots English Trường Chinh" },
  { brch_id: 383, brch_name: "Scots English Từ Sơn" },
  { brch_id: 354, brch_name: "Scots English Văn Khê" },
  { brch_id: 380, brch_name: "Scots English Việt Trì" },
  { brch_id: 388, brch_name: "Scots English Vinh" },
  { brch_id: 376, brch_name: "Scots English Vĩnh Phúc" },
  { brch_id: 378, brch_name: "Scots English Vĩnh Phúc 3" },
  { brch_id: 367, brch_name: "Scots English Vinhomes Gardenia" },
  { brch_id: 349, brch_name: "Scots English Vinhomes Smart City" },
  { brch_id: 375, brch_name: "Scots English Vinhomes Smart City 2" }
];

// Chi nhánh -> Vùng. Khi mở chi nhánh mới, thêm 1 dòng vào đây (đúng format
// "Scots English <Tên chi nhánh>").
const REGION_MAP_RAW = `Vùng 1\tKim Giang
Vùng 1\tThanh Hóa
Vùng 1\tLam Sơn
Vùng 1\tNguyễn Xiển
Vùng 1\tLinh Đàm
Vùng 1\tTây Hồ
Vùng 1\tNguyễn Tuân
Vùng 1\tHoàng Đạo Thúy
Vùng 1\tHoàng Quốc Việt
Vùng 1\tTrung Văn
Vùng của Liên\tHải Dương
Vùng của Liên\tVĩnh Phúc
Vùng của Liên\tLong Biên
Vùng của Liên\tVĩnh Phúc 3
Vùng của Liên\tPhúc Yên
Vùng của Liên\tViệt Trì
Vùng của Liên\tMỹ Đình
Vùng của Liên\tVinhomes Gardenia
Vùng 3\tTimes City
Vùng 3\tVăn Khê
Vùng 3\tAn Khánh
Vùng 3\tVinhomes Smart City
Vùng 3\tVinhomes Smart City 2
Vùng 3\tDương Nội
Vùng 3\tPhạm Văn Đồng
Vùng 3\tThái Bình
Vùng 5\tTừ Sơn
Vùng 5\tHải Phòng 2
Vùng 5\tHải Phòng
Vùng 5\tBắc Ninh
Vùng 5\tBắc Ninh 2
Vùng 5\tBắc Giang
Vùng 6\tSài Đồng
Vùng 6\tVinh
Vùng 6\tOcean Park
Vùng 6\tTrường Chinh
Vùng 6\tĐịnh Công
Vùng 7\tĐà Nẵng
Vùng 7\tĐà Nẵng 2
Vùng 7\tPhan Văn Trị
Vùng 8\tCeladon - Tân Phú
Vùng 8\tPhạm Văn Chiêu
Vùng 8\tGrand Park`;

function buildRegionMap() {
  const map = {};
  REGION_MAP_RAW.trim().split("\n").forEach(line => {
    const [region, campus] = line.split("\t");
    map["Scots English " + campus.trim()] = region.trim();
  });
  return map;
}
const REGION_MAP = buildRegionMap();

function postJson(urlStr, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const url = new URL(urlStr);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      res => {
        let data = "";
        res.on("data", c => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const loginId = process.env.LMS_LOGIN_ID;
  const loginPassword = process.env.LMS_LOGIN_PASSWORD;
  const appsScriptUrl = process.env.CLEARNING_APPS_SCRIPT_URL;
  const appsScriptToken = process.env.CLEARNING_APPS_SCRIPT_TOKEN;
  if (!loginId || !loginPassword) {
    throw new Error("Thiếu biến môi trường LMS_LOGIN_ID / LMS_LOGIN_PASSWORD");
  }
  if (!appsScriptUrl || !appsScriptToken) {
    throw new Error("Thiếu biến môi trường CLEARNING_APPS_SCRIPT_URL / CLEARNING_APPS_SCRIPT_TOKEN");
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  page.on("dialog", async dialog => {
    console.log(`[DIALOG từ trang] ${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss().catch(() => {});
  });

  console.log("== Đăng nhập LMS ==");
  await page.goto(LOGIN_URL, { waitUntil: "networkidle" });
  await page.waitForSelector("#login_id", { state: "visible" });
  await page.fill("#login_id", loginId);
  await page.fill("#login_password", loginPassword);
  await page.click("#btn_login");

  try {
    await page.waitForFunction(() => !location.href.includes("login.html"), { timeout: 60000 });
    console.log("Đăng nhập OK. URL hiện tại:", page.url());
  } catch (err) {
    console.log("== ĐĂNG NHẬP THẤT BẠI — đang lưu ảnh chụp + HTML để debug ==");
    const debugDir = path.join(__dirname, "..", "debug");
    fs.mkdirSync(debugDir, { recursive: true });
    await page.screenshot({ path: path.join(debugDir, "login-failed.png"), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(debugDir, "login-failed.html"), await page.content().catch(() => "(không lấy được HTML)"));
    await browser.close();
    throw err;
  }

  const outDir = path.join(__dirname, "..", "data");
  fs.mkdirSync(outDir, { recursive: true });
  const statePath = path.join(outDir, "clearning_state.json");

  function loadJsonSafe(p, fallback) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return fallback;
    }
  }

  const repoRoot = path.join(__dirname, "..");
  function gitCheckpointCommit(message) {
    try {
      execSync("git add data/clearning_state.json", { cwd: repoRoot, stdio: "pipe" });
      const hasChanges = execSync("git diff --cached --name-only", { cwd: repoRoot }).toString().trim().length > 0;
      if (!hasChanges) return;
      execSync(`git commit -m "${message.replace(/"/g, "'")}"`, { cwd: repoRoot, stdio: "pipe" });
      execSync("git push", { cwd: repoRoot, stdio: "pipe" });
    } catch (err) {
      console.log("[CẢNH BÁO] Commit/push checkpoint thất bại:", String(err?.message ?? err).slice(0, 300));
    }
  }

  const prevState = loadJsonSafe(statePath, null);
  const isResuming = !!(prevState && prevState.status === "in_progress" && Array.isArray(prevState.remainingClasses) && prevState.remainingClasses.length > 0);

  let classesForCycle;
  if (isResuming) {
    console.log(`== Đang TIẾP TỤC vòng quét dang dở: còn ${prevState.remainingClasses.length} lớp ==`);
    classesForCycle = prevState.remainingClasses;
  }

  // ================= BƯỚC 1: Class Plan + Class ID Cache =================
  let step1 = { cacheRows: [], errorRows: [] };
  if (!isResuming) {
    console.log("== Đang build Class Plan + Class ID Cache (vòng quét mới) ==");
    step1 = await page.evaluate(
      async ({ BASE, STAFF_ID, BRANCHES, deadline }) => {
        const normalize = v =>
          String(v ?? "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");

        async function post(endpoint, body, attempt = 1) {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 25000);
            let res;
            try {
              res = await fetch(`${BASE}/${endpoint}`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json;charset=UTF-8" },
                body: JSON.stringify(body),
                signal: controller.signal
              });
            } finally {
              clearTimeout(timeoutId);
            }
            const text = await res.text();
            if ([502, 503, 504].includes(res.status) && attempt < 3) {
              await new Promise(r => setTimeout(r, 1000 * attempt));
              return post(endpoint, body, attempt + 1);
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`);
            const json = JSON.parse(text);
            if (!json?.d?.result) return [];
            return JSON.parse(json.d.result).Table || [];
          } catch (err) {
            if (attempt < 3) {
              await new Promise(r => setTimeout(r, 1000 * attempt));
              return post(endpoint, body, attempt + 1);
            }
            throw err;
          }
        }

        const classPlanMap = new Map();
        const cacheRows = [];
        const errorRows = [];
        const seenCache = new Set();
        let stoppedEarly = false;

        for (const branch of BRANCHES) {
          if (Date.now() >= deadline) {
            stoppedEarly = true;
            errorRows.push({ Branch: branch.brch_name, Step: "Deadline", Error: "Chưa xử lý do hết thời gian" });
            continue;
          }
          try {
            const semesters = await post("CounSemester", { staff: { stf_id: STAFF_ID }, setup: { hr_brch_id: branch.brch_id } });
            const bsemId = semesters?.[0]?.bsem_id;
            if (!bsemId) {
              errorRows.push({ Branch: branch.brch_name, Step: "CounSemester", Error: "No bsem_id" });
              continue;
            }

            const statClasses = await post("reportStaticsClassList", { ret: { rt_brch_id: branch.brch_id, rt_bsem_id: bsemId, rt_cors_id: 0, rt_syl_id: 0 } });
            for (const c of statClasses) {
              const planBranch = c.brch_name ?? branch.brch_name;
              const className = c.cls_name ?? "";
              if (!className) continue;
              const key = `${normalize(planBranch)}|${normalize(className)}`;
              const planRow = {
                Branch: planBranch,
                Program: c.top_cors_name ?? "",
                Level: c.clevel_name ?? "",
                Syllabus: c.syl_name ?? "",
                Class: className,
                StartDate: c.cls_startdate ?? "",
                bsem_id: bsemId,
                brch_id: branch.brch_id
              };
              if (!classPlanMap.has(key)) classPlanMap.set(key, planRow);
              else if (!classPlanMap.get(key).StartDate && planRow.StartDate) classPlanMap.set(key, planRow);
            }

            const programs = await post("CounStudentClassProgram", { counn: { coun_bsem_id: bsemId } });
            for (const program of programs) {
              const corsId = program.id ?? program.cors_id ?? "";
              const programName = program.name ?? program.cors_name ?? "";
              if (!corsId) continue;

              const syllabuses = await post("CounStudentClassSyllabus", { counn: { coun_bsem_id: bsemId, coun_cors_id: corsId } });
              for (const syl of syllabuses) {
                const sylId = syl.syl_id ?? "";
                const sylName = syl.syl_name ?? "";
                if (!sylId) continue;

                const classes = await post("CounRptStudentClassList", { counn: { coun_bsem_id: bsemId, coun_syl_id: sylId, coun_cls_isclosed: 0 } });
                for (const cls of classes) {
                  const className = cls.cls_name ?? "";
                  const clsId = cls.cls_id ?? "";
                  if (!className || !clsId) continue;
                  const cacheKey = [branch.brch_id, bsemId, corsId, sylId, clsId].join("||");
                  if (seenCache.has(cacheKey)) continue;
                  seenCache.add(cacheKey);

                  const planKey = `${normalize(branch.brch_name)}|${normalize(className)}`;
                  const plan = classPlanMap.get(planKey);
                  cacheRows.push({
                    Branch: branch.brch_name,
                    Class: className,
                    brch_id: branch.brch_id,
                    bsem_id: bsemId,
                    cors_id: corsId,
                    syl_id: sylId,
                    cls_id: clsId,
                    Program: plan?.Program || programName,
                    Syllabus: plan?.Syllabus || sylName,
                    StartDate: plan?.StartDate ?? ""
                  });
                }
              }
            }
          } catch (err) {
            errorRows.push({ Branch: branch.brch_name, Step: "Branch Loop", Error: String(err?.message ?? err) });
          }
        }
        return { cacheRows, errorRows, stoppedEarly };
      },
      { BASE, STAFF_ID, BRANCHES, deadline: Date.now() + CACHE_BUILD_BUDGET_MS }
    );

    console.log(`Class ID Cache: ${step1.cacheRows.length} lớp. Lỗi: ${step1.errorRows.length}`);
    classesForCycle = step1.cacheRows;

    fs.writeFileSync(
      statePath,
      JSON.stringify({ status: "in_progress", cycleStartedAt: new Date().toISOString(), totalClassesInCycle: classesForCycle.length, remainingClasses: classesForCycle, studentSummary: {}, classSummary: {}, dedupKeys: [] }, null, 2)
    );
  }

  let studentSummary = isResuming ? prevState.studentSummary || {} : {};
  let classSummary = isResuming ? prevState.classSummary || {} : {};
  let dedupKeysArr = isResuming ? prevState.dedupKeys || [] : [];
  const totalClassesInCycle = isResuming ? prevState.totalClassesInCycle : classesForCycle.length;
  const cycleStartedAt = isResuming ? prevState.cycleStartedAt : new Date().toISOString();

  // ================= BƯỚC 2: Cào điểm Homework / Book Test / Lesson Quiz =================
  const deadline = Date.now() + TIME_BUDGET_MS;
  console.log(`== Đang cào điểm c-Learning (giới hạn nội bộ ${TIME_BUDGET_MS / 60000} phút) ==`);

  const reportDateIso = new Date().toISOString().slice(0, 10);

  let step2;
  try {
    step2 = await page.evaluate(
      async ({ BASE, classes, MAX_WEEK, reportDateIso, deadline, prevStudentSummary, prevClassSummary, prevDedupKeys }) => {
        const CONCURRENCY = 3;
        const REQUEST_DELAY_MS = 150;
        const CHECKPOINT_EVERY = 50;
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const evalMap = { "Homework Completion": "Homework", "Book Test": "Book Test", "Lesson Quiz": "Lesson Quiz" };

        async function post(endpoint, body, attempt = 1) {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 25000);
            let res;
            try {
              res = await fetch(`${BASE}/${endpoint}`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json;charset=UTF-8" },
                body: JSON.stringify(body),
                signal: controller.signal
              });
            } finally {
              clearTimeout(timeoutId);
            }
            const text = await res.text();
            if ([502, 503, 504].includes(res.status) && attempt < 3) {
              await sleep(1000 * attempt);
              return post(endpoint, body, attempt + 1);
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`);
            const json = JSON.parse(text);
            if (!json?.d?.result) return [];
            return JSON.parse(json.d.result).Table || [];
          } catch (err) {
            if (attempt < 3) {
              await sleep(1000 * attempt);
              return post(endpoint, body, attempt + 1);
            }
            throw err;
          }
        }

        // Dùng dữ liệu THẬT từ CounClassInfoJournalList (ngày thực tế đã diễn ra
        // của từng Lecture) thay vì ước tính theo lịch (Start Date + số ngày),
        // vì lớp có thể học bù/nghỉ/lệch lịch so với kế hoạch ban đầu.
        const reportDate = new Date(reportDateIso);
        const parseJournalDate = raw => {
          const m = String(raw ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
          return m ? new Date(m[1]) : null;
        };
        const journalCache = new Map(); // tránh gọi lại nếu 1 job được xử lý lại (resume)
        async function getActualWeek(job) {
          if (journalCache.has(job.cls_id)) return journalCache.get(job.cls_id);
          let maxLecture = 0;
          try {
            const rows = await post("CounClassInfoJournalList", { counn: { coun_cls_id: job.cls_id } });
            for (const r of rows) {
              const lectureNo = Number(String(r.Lecture ?? "").match(/\d+/)?.[0]) || 0;
              const d = parseJournalDate(r.Date);
              // Chỉ tính lecture đã THỰC SỰ diễn ra (ngày <= hôm nay), không tính
              // các buổi đã lên lịch sẵn nhưng chưa tới (Att/Abs = 0, Taught = null)
              if (lectureNo > 0 && d && d <= reportDate && lectureNo > maxLecture) maxLecture = lectureNo;
            }
          } catch (err) {
            // Nếu lỗi (lớp mới, chưa có Journal...) coi như chưa học buổi nào,
            // để không cào nhầm dữ liệu tuần chưa diễn ra
            maxLecture = 0;
          }
          const result = Math.min(maxLecture, MAX_WEEK);
          journalCache.set(job.cls_id, result);
          return result;
        }
        const safeNumber = v => {
          const n = Number(v);
          return v === null || v === undefined || v === "" || Number.isNaN(n) ? null : n;
        };
        const initBucket = () => ({ total: 0, inputCount: 0, scoreCount: 0, scoreTotal: 0 });

        const studentSummary = prevStudentSummary || {};
        const classSummary = prevClassSummary || {};
        const dedupKeys = new Set(prevDedupKeys || []);
        const errors = [];

        function addStudentSummary({ branch, program, syllabus, className, studentId, studentName, evaluation, score }) {
          const label = evalMap[evaluation];
          if (!label) return;
          const key = [branch, program, syllabus, className, studentId, studentName].join("||");
          if (!studentSummary[key]) {
            studentSummary[key] = { Branch: branch, Program: program, Syllabus: syllabus, Class: className, ID: studentId, Name: studentName, evaluations: {} };
          }
          if (!studentSummary[key].evaluations[label]) studentSummary[key].evaluations[label] = initBucket();
          const bucket = studentSummary[key].evaluations[label];
          bucket.total++;
          const scoreNum = safeNumber(score);
          if (scoreNum !== null) {
            bucket.inputCount++;
            bucket.scoreCount++;
            bucket.scoreTotal += scoreNum;
          }
        }

        function addClassSummary({ branch, program, syllabus, className, weekNo, evaluation, score }) {
          const label = evalMap[evaluation];
          if (!label) return;
          const key = [branch, program, syllabus, className].join("||");
          if (!classSummary[key]) {
            classSummary[key] = { Branch: branch, Program: program, Syllabus: syllabus, Class: className, UpToWeek: 0, evaluations: {} };
          }
          classSummary[key].UpToWeek = Math.max(classSummary[key].UpToWeek || 0, weekNo);
          if (!classSummary[key].evaluations[label]) classSummary[key].evaluations[label] = initBucket();
          const bucket = classSummary[key].evaluations[label];
          bucket.total++;
          const scoreNum = safeNumber(score);
          if (scoreNum !== null) {
            bucket.inputCount++;
            bucket.scoreCount++;
            bucket.scoreTotal += scoreNum;
          }
        }

        // Lấy danh sách tuần (week_id) cho mỗi bsem_id, dùng chung cho các lớp cùng học kỳ
        const uniqueBsemIds = [...new Set(classes.map(j => j.bsem_id))];
        const weekMapByBsem = new Map();
        for (const bsemId of uniqueBsemIds) {
          const weeksAll = await post("ReportCommonWeek", { ret: { rt_bsem_id: bsemId } });
          const weekMap = new Map();
          for (const w of weeksAll) {
            const weekNo = Number(String(w.week_name || "").match(/\d+/)?.[0]);
            if (weekNo >= 1 && weekNo <= MAX_WEEK && !weekMap.has(weekNo)) weekMap.set(weekNo, w);
          }
          weekMapByBsem.set(bsemId, weekMap);
        }

        let done = 0;

        async function processClass(job) {
          const expWeek = await getActualWeek(job);
          for (let weekNo = 1; weekNo <= expWeek; weekNo++) {
            const week = weekMapByBsem.get(job.bsem_id)?.get(weekNo);
            if (!week) continue;
            try {
              const gradeRows = await post("ReportGrdWeekliGradeList", {
                ret: {
                  rt_brch_id: job.brch_id, rt_bsem_id: job.bsem_id, rt_cors_id: job.cors_id,
                  rt_syl_id: job.syl_id, rt_cls_id: job.cls_id, rt_week_id: week.week_id,
                  rt_learn_type: "c-Learning", rt_preview: 0, rt_review: 0, rt_skill: 0, rt_notgrade: 0
                }
              });

              gradeRows.forEach(r => {
                const program = r.top_cors_name ?? job.Program ?? "";
                const className = r.cls_name ?? job.Class ?? "";
                const score = r.score ?? "";
                const evaluation = r.esdtl_type ?? "";
                const studentId = r.cstd_id ?? r.cstd_id1 ?? r.std_id ?? "";
                const studentName = r.std_name ?? "";
                const label = evalMap[evaluation];
                if (!label) return;

                let shouldCount = true;
                if (label === "Homework") {
                  const dedupKey = [job.Branch, className, weekNo, studentId || studentName, label].join("||");
                  if (dedupKeys.has(dedupKey)) shouldCount = false;
                  else dedupKeys.add(dedupKey);
                }
                if (shouldCount) {
                  addStudentSummary({ branch: job.Branch, program, syllabus: job.Syllabus ?? "", className, studentId, studentName, evaluation, score });
                  addClassSummary({ branch: job.Branch, program, syllabus: job.Syllabus ?? "", className, weekNo, evaluation, score });
                }
              });
            } catch (err) {
              errors.push({ Branch: job.Branch, Class: job.Class, Week: weekNo, Error: String(err?.message ?? err) });
            }
            await sleep(REQUEST_DELAY_MS);
          }
          done++;
          if (done % 10 === 0 || done === classes.length) {
            console.log(`Đã xử lý ${done}/${classes.length} lớp | Lỗi: ${errors.length}`);
          }
        }

        let index = 0;
        await Promise.all(
          Array.from({ length: CONCURRENCY }, async () => {
            while (index < classes.length && Date.now() < deadline) await processClass(classes[index++]);
          })
        );

        return {
          studentSummary, classSummary, dedupKeys: [...dedupKeys],
          errors, stoppedEarly: index < classes.length, processedIndex: index, totalClasses: classes.length
        };
      },
      { BASE, classes: classesForCycle, MAX_WEEK, reportDateIso, deadline, prevStudentSummary: studentSummary, prevClassSummary: classSummary, prevDedupKeys: dedupKeysArr }
    );
  } catch (err) {
    console.log("== Bước cào điểm bị gián đoạn giữa chừng ==");
    console.log("Lý do:", String(err?.message ?? err));
    await browser.close();
    process.exit(0);
  }

  studentSummary = step2.studentSummary;
  classSummary = step2.classSummary;
  dedupKeysArr = step2.dedupKeys;

  console.log(`Đã xử lý ${step2.processedIndex}/${step2.totalClasses} lớp trong lần chạy này. Lỗi: ${step2.errors.length}`);

  if (step2.stoppedEarly) {
    const remaining = classesForCycle.slice(step2.processedIndex);
    console.log(`== Hết thời gian nội bộ — còn ${remaining.length} lớp sẽ được lần chạy kế tiếp tiếp tục ==`);
    fs.writeFileSync(
      statePath,
      JSON.stringify({ status: "in_progress", cycleStartedAt, totalClassesInCycle, remainingClasses: remaining, studentSummary, classSummary, dedupKeys: dedupKeysArr }, null, 2)
    );
    gitCheckpointCommit(`Checkpoint c-Learning: ${step2.processedIndex}/${step2.totalClasses} lớp`);
    await browser.close();
    console.log("== Dừng lại giữa vòng quét, chờ lần chạy kế tiếp tiếp tục. Chưa đẩy dữ liệu lên Apps Script. ==");
    return;
  }

  // ================= Vòng quét đã xong hoàn toàn -> build rows cuối + đẩy lên Apps Script =================
  console.log("== Đã quét xong toàn bộ lớp trong vòng này -> đang tổng hợp kết quả ==");

  function buildRows(summaryObj, isStudent) {
    return Object.values(summaryObj).map(s => {
      const region = REGION_MAP[s.Branch] || "Chưa gán vùng";
      const row = {
        region, branch: s.Branch, program: s.Program, syllabus: s.Syllabus, class_name: s.Class,
        hw_records: s.evaluations["Homework"]?.total ?? 0,
        bt_records: s.evaluations["Book Test"]?.total ?? 0,
        lq_records: s.evaluations["Lesson Quiz"]?.total ?? 0,
        hw_input: s.evaluations["Homework"]?.inputCount ?? 0,
        bt_input: s.evaluations["Book Test"]?.inputCount ?? 0,
        lq_input: s.evaluations["Lesson Quiz"]?.inputCount ?? 0,
        hw_score_total: s.evaluations["Homework"]?.scoreTotal ?? 0,
        hw_score_count: s.evaluations["Homework"]?.scoreCount ?? 0,
        bt_score_total: s.evaluations["Book Test"]?.scoreTotal ?? 0,
        bt_score_count: s.evaluations["Book Test"]?.scoreCount ?? 0,
        lq_score_total: s.evaluations["Lesson Quiz"]?.scoreTotal ?? 0,
        lq_score_count: s.evaluations["Lesson Quiz"]?.scoreCount ?? 0
      };
      if (isStudent) {
        row.student_id = s.ID;
        row.name = s.Name;
      } else {
        row.week = s.UpToWeek;
      }
      return row;
    });
  }

  const classRows = buildRows(classSummary, false);
  const studentRows = buildRows(studentSummary, true);

  // Gán "week" cho từng học viên theo lớp (để đồng bộ với dashboard)
  const weekLookup = {};
  classRows.forEach(c => { weekLookup[c.branch + "|" + c.class_name] = c.week; });
  studentRows.forEach(s => { s.week = weekLookup[s.branch + "|" + s.class_name]; });

  console.log(`Tổng hợp xong: ${classRows.length} lớp, ${studentRows.length} học viên. Đang đẩy lên Apps Script...`);

  try {
    const res = await postJson(appsScriptUrl, { token: appsScriptToken, classRows, studentRows });
    console.log("Kết quả đẩy dữ liệu:", res.status, res.body.slice(0, 300));
  } catch (err) {
    console.log("[LỖI] Không đẩy được dữ liệu lên Apps Script:", String(err?.message ?? err));
    await browser.close();
    process.exit(1);
  }

  fs.writeFileSync(statePath, JSON.stringify({ status: "done", cycleFinishedAt: new Date().toISOString(), totalClassesInCycle }, null, 2));
  gitCheckpointCommit("c-Learning: hoàn tất 1 vòng quét, đã đẩy dữ liệu lên Apps Script");

  await browser.close();
  console.log("== Hoàn tất ==");
}

main().catch(err => {
  console.error("Scrape c-Learning thất bại:", err);
  process.exit(1);
});
