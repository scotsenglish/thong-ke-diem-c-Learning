/**
 * Code.gs — Backend Apps Script cho Dashboard c-Learning (real-time)
 * ---------------------------------------------------------------------------
 * CÁCH THIẾT LẬP:
 * 1. Vào https://script.google.com -> New project
 * 2. Xoá code mặc định, paste toàn bộ nội dung file này vào
 * 3. Vào Project Settings (icon bánh răng bên trái) -> Script Properties ->
 *    Add script property:
 *      - Tên: WRITE_TOKEN
 *      - Giá trị: 1 chuỗi bí mật tự đặt (ví dụ: dùng lệnh `openssl rand -hex 16`
 *        hoặc tự nghĩ ra 1 chuỗi dài random) — token này dùng để xác thực
 *        script cào dữ liệu, không cho người lạ ghi đè dữ liệu.
 * 4. Bấm Deploy -> New deployment -> chọn loại "Web app"
 *      - Execute as: Me
 *      - Who has access: Anyone
 *    Bấm Deploy -> Copy URL (dạng https://script.google.com/macros/s/.../exec)
 * 5. URL đó chính là CLEARNING_APPS_SCRIPT_URL, token ở bước 3 chính là
 *    CLEARNING_APPS_SCRIPT_TOKEN -> thêm cả 2 vào GitHub Secrets của repo.
 * 6. Script này tự tạo 3 sheet "ClassData", "StudentData", "RawScores" trong
 *    Google Sheet gắn liền với Apps Script project (Container-bound). Không
 *    cần tạo sheet thủ công trước.
 *      - ClassData / StudentData: số liệu tổng hợp (% và điểm TB) cho dashboard chính
 *      - RawScores: điểm THÔ từng buổi (Lecture) của từng học viên trong từng
 *        lớp — dùng cho tab Tra cứu chi tiết theo lớp
 * 7. BACKUP TỰ ĐỘNG: mỗi lần nhận dữ liệu mới (3 lần/ngày theo lịch scraper),
 *    script tự tạo 1 file .xlsx lưu vào thư mục Drive tên "cLearning Backups"
 *    (tự tạo nếu chưa có), đặt tên kèm ngày giờ (VD: cLearning_Backup_2026-07-21_0600.xlsx).
 *    LẦN DEPLOY ĐẦU TIÊN sau khi thêm tính năng này, Google sẽ hiện màn hình
 *    xin thêm quyền truy cập Drive — bấm "Advanced" -> "Go to (tên project) (unsafe)"
 *    -> Allow để cấp quyền (đây là bước bảo mật bình thường của Google, không
 *    phải lỗi).
 * 8. LƯU Ý QUAN TRỌNG: mỗi lần sửa code trong editor (kể cả sửa từ file này
 *    rồi paste lại), phải vào Deploy -> Manage deployments -> bấm nút sửa
 *    (icon bút chì) trên deployment "Web app" đang dùng -> Version: chọn
 *    "New" -> Deploy, thì Web App URL hiện tại (đang được scraper gọi tới)
 *    mới thực sự chạy code mới. Chỉ lưu (Ctrl+S) trong editor KHÔNG đủ — đây
 *    chính là lý do khiến tính năng backup vào folder từng không hoạt động dù
 *    code đã đúng: code mới chưa từng được đưa vào bản deploy đang chạy.
 *    Sau khi redeploy, có thể verify nhanh không cần đợi scraper: trong
 *    editor, chọn function "saveBackupSnapshot" ở dropdown "Select function"
 *    -> Run, rồi kiểm tra Script Properties có xuất hiện "BACKUP_FOLDER_ID"
 *    và Drive có folder "cLearning Backups" chứa file .xlsx mới.
 * ---------------------------------------------------------------------------
 */

const CLASS_SHEET_NAME = "ClassData";
const STUDENT_SHEET_NAME = "StudentData";
const RAW_SHEET_NAME = "RawScores";

function getOrCreateSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1).setValue("json");
  }
  return sheet;
}

function writeRows(sheetName, rows) {
  const sheet = getOrCreateSheet(sheetName);
  sheet.clearContents();
  sheet.getRange(1, 1).setValue("json");
  if (!rows || rows.length === 0) return;
  const values = rows.map(r => [JSON.stringify(r)]);
  sheet.getRange(2, 1, values.length, 1).setValues(values);
}

function readRows(sheetName) {
  const sheet = getOrCreateSheet(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const out = [];
  for (const row of values) {
    const cell = row[0];
    if (!cell) continue;
    try {
      out.push(JSON.parse(cell));
    } catch (e) {
      // bỏ qua dòng lỗi format, không làm hỏng cả response
    }
  }
  return out;
}

// Tìm 1 dòng cụ thể trong RawScores theo tên lớp (và chi nhánh nếu có), tránh
// phải trả về toàn bộ dữ liệu chi tiết (rất nặng) mỗi lần tra cứu.
function findRawRowByClass(className, branch) {
  const sheet = getOrCreateSheet(RAW_SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const target = String(className || "").trim().toLowerCase();
  const targetBranch = String(branch || "").trim().toLowerCase();
  for (const row of values) {
    const cell = row[0];
    if (!cell) continue;
    try {
      const parsed = JSON.parse(cell);
      const cls = String(parsed.class_name || "").trim().toLowerCase();
      if (cls === target) {
        if (targetBranch && String(parsed.branch || "").trim().toLowerCase() !== targetBranch) continue;
        return parsed;
      }
    } catch (e) {
      // bỏ qua dòng lỗi format
    }
  }
  return null;
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const expectedToken = PropertiesService.getScriptProperties().getProperty("WRITE_TOKEN");

    if (!expectedToken) {
      return jsonOutput({ ok: false, error: "Chưa cấu hình WRITE_TOKEN trong Script Properties" });
    }
    if (body.token !== expectedToken) {
      return jsonOutput({ ok: false, error: "Token không đúng" });
    }

    if (Array.isArray(body.classRows)) writeRows(CLASS_SHEET_NAME, body.classRows);
    if (Array.isArray(body.studentRows)) writeRows(STUDENT_SHEET_NAME, body.studentRows);
    if (Array.isArray(body.rawRows)) writeRows(RAW_SHEET_NAME, body.rawRows);

    // Ghi lại thời điểm cập nhật gần nhất để dashboard có thể hiển thị
    PropertiesService.getScriptProperties().setProperty("LAST_UPDATED", new Date().toISOString());

    // Lưu 1 bản backup .xlsx vào Drive mỗi lần nhận dữ liệu mới (3 lần/ngày).
    // Lỗi ở bước này KHÔNG được làm hỏng phần ghi dữ liệu chính ở trên, nhưng
    // vẫn báo lại trong response để dễ phát hiện nếu backup có vấn đề (thay vì
    // chỉ nằm im trong log Apps Script mà không ai biết).
    let backupError = null;
    let backupFolderUrl = null;
    try {
      const folder = saveBackupSnapshot(body.classRows || [], body.studentRows || []);
      backupFolderUrl = folder ? folder.getUrl() : null;
    } catch (backupErr) {
      backupError = String(backupErr);
      console.error("Backup thất bại: " + backupErr);
    }

    return jsonOutput({
      ok: true,
      classCount: (body.classRows || []).length,
      studentCount: (body.studentRows || []).length,
      rawClassCount: (body.rawRows || []).length,
      backupError,
      backupFolderUrl
    });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  const type = (e.parameter.type || "").toLowerCase();
  const callback = e.parameter.callback;

  let data;
  if (type === "class") {
    data = readRows(CLASS_SHEET_NAME);
  } else if (type === "student") {
    data = readRows(STUDENT_SHEET_NAME);
  } else if (type === "raw") {
    // Bắt buộc phải có ?class=<tên lớp> để tránh trả về toàn bộ dữ liệu thô
    // (rất nặng) — chỉ trả về đúng 1 lớp được yêu cầu.
    const className = e.parameter.class || "";
    const branch = e.parameter.branch || "";
    if (!className) {
      return jsonOutput({ ok: false, error: "Thiếu tham số ?class=<tên lớp> khi tra cứu raw" }, callback);
    }
    data = findRawRowByClass(className, branch) || { ok: false, error: "Không tìm thấy dữ liệu chi tiết cho lớp này" };
  } else if (type === "meta") {
    data = { lastUpdated: PropertiesService.getScriptProperties().getProperty("LAST_UPDATED") || null };
  } else {
    return jsonOutput({ ok: false, error: "Thiếu tham số ?type=class hoặc ?type=student hoặc ?type=raw hoặc ?type=meta" }, callback);
  }

  return jsonOutput(data, callback);
}

function jsonOutput(obj, callback) {
  const json = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(`${callback}(${json})`).setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// BACKUP: mỗi lần nhận dữ liệu mới, xuất 1 file .xlsx dễ đọc (không phải JSON
// thô) lưu vào thư mục Drive riêng — 3 file/ngày, đặt tên kèm ngày giờ.
// ---------------------------------------------------------------------------

const BACKUP_FOLDER_NAME = "cLearning Backups";

function getOrCreateBackupFolder() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty("BACKUP_FOLDER_ID");
  if (savedId) {
    try {
      const existing = DriveApp.getFolderById(savedId);
      // Kiểm tra file vẫn còn tồn tại, chưa bị xoá thủ công
      existing.getName();
      return existing;
    } catch (e) {
      // ID cũ không còn hợp lệ (folder đã bị xoá) -> tạo lại bên dưới
    }
  }
  const folder = DriveApp.createFolder(BACKUP_FOLDER_NAME);
  props.setProperty("BACKUP_FOLDER_ID", folder.getId());
  return folder;
}

function saveBackupSnapshot(classRows, studentRows) {
  const tz = "Asia/Ho_Chi_Minh";
  const stamp = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd_HHmm");
  const fileBaseName = "cLearning_Backup_" + stamp;

  // Tạo 1 Google Sheet tạm với định dạng cột dễ đọc (giống file Excel export
  // thủ công trước đây), xuất thành .xlsx thật, rồi xoá bản Google Sheet tạm.
  const tempSs = SpreadsheetApp.create(fileBaseName);
  try {
    const classSheet = tempSs.getSheets()[0];
    classSheet.setName("c-Learning Summary");
    writeReadableSheet(classSheet, classRows, false);

    const studentSheet = tempSs.insertSheet("c-Learning Student Summary");
    writeReadableSheet(studentSheet, studentRows, true);
    SpreadsheetApp.flush();

    const fileId = tempSs.getId();
    const exportUrl = "https://docs.google.com/spreadsheets/d/" + fileId + "/export?format=xlsx";
    const response = UrlFetchApp.fetch(exportUrl, {
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() }
    });
    const blob = response.getBlob().setName(fileBaseName + ".xlsx");

    const folder = getOrCreateBackupFolder();
    // Tạo file rồi CHỦ ĐỘNG gán vào đúng folder + gỡ khỏi root — chắc chắn hơn
    // là chỉ gọi folder.createFile(blob), vì thực tế có lúc file vẫn bị tạo ở
    // root dù gọi trên object folder.
    const newFile = DriveApp.createFile(blob);
    folder.addFile(newFile);
    DriveApp.getRootFolder().removeFile(newFile);
    return folder;
  } finally {
    // Chỉ giữ lại file .xlsx thật trong thư mục backup; xoá bản Google Sheet
    // tạm dùng để tạo ra nó (chuyển vào Thùng rác, tự dọn theo chính sách Google).
    DriveApp.getFileById(tempSs.getId()).setTrashed(true);
  }
}

function writeReadableSheet(sheet, rows, isStudent) {
  if (!rows || !rows.length) {
    sheet.getRange(1, 1).setValue("Không có dữ liệu ở lần cào này");
    return;
  }

  // QUAN TRỌNG: các tên cột bắt buộc dưới đây (Branch, Class, Homework Records,
  // Homework Input Count, Homework Score Total, Homework Score Count, tương tự
  // cho Book Test/Lesson Quiz, và Up To Week) phải khớp CHÍNH XÁC với tên cột
  // mà nút "Tải file export mới" trên dashboard đang tìm — để file backup này
  // có thể tải NGƯỢC LẠI vào dashboard khi cần (ví dụ khôi phục dữ liệu, hoặc
  // xem lại 1 mốc thời gian cũ). Các cột còn lại (Vùng, %, Điểm TB...) chỉ để
  // tiện xem bằng mắt, dashboard sẽ bỏ qua khi đọc lại.
  const headers = ["Vùng", "Branch", "Program", "Syllabus", "Class"];
  if (isStudent) headers.push("ID", "Name");
  headers.push(
    "Homework Records", "Homework Input Count", "Homework %", "Homework Score Total", "Homework Score Count", "Homework Avg",
    "Book Test Records", "Book Test Input Count", "Book Test %", "Book Test Score Total", "Book Test Score Count", "Book Test Avg",
    "Lesson Quiz Records", "Lesson Quiz Input Count", "Lesson Quiz %", "Lesson Quiz Score Total", "Lesson Quiz Score Count", "Lesson Quiz Avg"
  );
  if (!isStudent) headers.push("Up To Week");

  const pct = (input, records) => (records ? Math.round((input / records) * 10000) / 100 : 0);
  const avg = (total, count) => (count ? Math.round((total / count) * 100) / 100 : "");

  const dataRows = rows.map(r => {
    const row = [r.region || "", r.branch || "", r.program || "", r.syllabus || "", r.class_name || ""];
    if (isStudent) row.push(r.student_id || "", r.name || "");
    row.push(
      r.hw_records || 0, r.hw_input || 0, pct(r.hw_input, r.hw_records), r.hw_score_total || 0, r.hw_score_count || 0, avg(r.hw_score_total, r.hw_score_count),
      r.bt_records || 0, r.bt_input || 0, pct(r.bt_input, r.bt_records), r.bt_score_total || 0, r.bt_score_count || 0, avg(r.bt_score_total, r.bt_score_count),
      r.lq_records || 0, r.lq_input || 0, pct(r.lq_input, r.lq_records), r.lq_score_total || 0, r.lq_score_count || 0, avg(r.lq_score_total, r.lq_score_count)
    );
    if (!isStudent) row.push(r.week || "");
    return row;
  });

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(2, 1, dataRows.length, headers.length).setValues(dataRows);
  sheet.setFrozenRows(1);
}
