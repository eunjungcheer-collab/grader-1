/**
 * 자동채점 시스템 — Apps Script 백엔드
 *
 * 사용 방법:
 * 1. 새 Google Sheet를 만든다.
 * 2. 확장 프로그램 → Apps Script 를 연다.
 * 3. 이 파일 내용 전체를 복사해서 Code.gs에 붙여넣는다.
 * 4. 상단 실행 드롭다운에서 setup 함수를 한 번 실행한다 (시트 탭 자동 생성 + 초기 비밀번호 설정).
 *    처음 실행 시 권한 승인 창이 뜨면 허용한다.
 * 5. 배포 → 새 배포 → 유형: 웹 앱
 *    - 실행할 사용자: 나(본인)
 *    - 액세스 권한이 있는 사용자: 모든 사용자(익명 사용자 포함)
 *    - 배포를 누르면 웹 앱 URL이 나온다. 이 URL을 js/config.js의 API_URL에 붙여넣는다.
 * 6. 코드를 수정할 때마다 "새 배포"가 아니라 기존 배포에서 "배포 관리 → 수정 → 새 버전"으로
 *    업데이트해야 URL이 안 바뀐다.
 */

const SHEET_EXAMS = 'Exams';
const SHEET_SCORES = 'Scores';
const SHEET_QUESTIONS = 'Questions';
const DRIVE_FOLDER_NAME = '자동채점_시험지PDF';
const BANK_FOLDER_NAME = '자동채점_문제은행이미지';

// ── 실행: 시트 탭과 기본 비밀번호를 만든다 (여러 번 실행해도 기존 데이터는 지워지지 않는다) ──
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET_EXAMS, ['id', 'title', 'answers', 'createdAt', 'pdfFileId', 'pdfUrl']);
  ensureSheet_(ss, SHEET_SCORES, ['examId', 'studentName', 'answers', 'score', 'total', 'submittedAt']);
  ensureSheet_(ss, SHEET_QUESTIONS, ['id', 'unit', 'answer', 'source', 'textPreview', 'createdAt', 'fileId']);

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TEACHER_PASSWORD')) {
    props.setProperty('TEACHER_PASSWORD', 'changeme');  // 배포 후 반드시 앱에서 변경하세요
  }
  // 해설지용 열 머리글 (기존 시트에도 안전하게 추가)
  ss.getSheetByName(SHEET_QUESTIONS).getRange(1, 8).setValue('explFileId');
  ss.getSheetByName(SHEET_SCORES).getRange(1, 7).setValue('score100');
  ss.getSheetByName(SHEET_QUESTIONS).getRange(1, 9).setValue('difficulty');
  ss.getSheetByName(SHEET_QUESTIONS).getRange(1, 10).setValue('diffScore');
  ss.getSheetByName(SHEET_QUESTIONS).getRange(1, 11).setValue('numRect');
  ss.getSheetByName(SHEET_QUESTIONS).getRange(1, 12).setValue('explNumRect');
  ss.getSheetByName(SHEET_EXAMS).getRange(1, 7).setValue('explUrl');
  ss.getSheetByName(SHEET_EXAMS).getRange(1, 8).setValue('sourceQuestionIds');
  ss.getSheetByName(SHEET_EXAMS).getRange(1, 9).setValue('composeRecipe');
  Logger.log('설정 완료. (이미 있던 데이터는 그대로 유지돼요)');
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.appendRow(headers);
  return sh;
}

function getBankFolder_() {
  const it = DriveApp.getFoldersByName(BANK_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(BANK_FOLDER_NAME);
}

function getOrCreateFolder_() {
  const it = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(DRIVE_FOLDER_NAME);
}

function checkPassword_(pw) {
  const stored = PropertiesService.getScriptProperties().getProperty('TEACHER_PASSWORD');
  return pw === stored;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return handle_(e);
}
function doPost(e) {
  return handle_(e);
}

function handle_(e) {
  try {
    let params = {};
    if (e.postData && e.postData.contents) {
      params = JSON.parse(e.postData.contents);
    } else {
      params = e.parameter;
    }
    const action = params.action;
    let result;
    switch (action) {
      case 'login': result = actionLogin_(params); break;
      case 'changePassword': result = actionChangePassword_(params); break;
      case 'createExam': result = actionCreateExam_(params); break;
      case 'listExams': result = actionListExams_(params); break;
      case 'getExamPublic': result = actionGetExamPublic_(params); break;
      case 'getExamDetail': result = actionGetExamDetail_(params); break;
      case 'submitAnswer': result = actionSubmitAnswer_(params); break;
      case 'listSubmissions': result = actionListSubmissions_(params); break;
      case 'deleteSubmission': result = actionDeleteSubmission_(params); break;
      case 'updateSubmissionScore': result = actionUpdateSubmissionScore_(params); break;
      case 'attachExplanation': result = actionAttachExplanation_(params); break;
      case 'saveQuestions': result = actionSaveQuestions_(params); break;
      case 'listQuestions': result = actionListQuestions_(params); break;
      case 'updateQuestion': result = actionUpdateQuestion_(params); break;
      case 'getPresets': result = actionGetPresets_(params); break;
      case 'setPresets': result = actionSetPresets_(params); break;
      case 'updateQuestions': result = actionUpdateQuestions_(params); break;
      case 'deleteQuestions': result = actionDeleteQuestions_(params); break;
      case 'deleteExam': result = actionDeleteExam_(params); break;
      case 'deleteQuestion': result = actionDeleteQuestion_(params); break;
      case 'getQuestionImages': result = actionGetQuestionImages_(params); break;
      default: result = { ok: false, error: 'unknown action' };
    }
    return json_(result);
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function actionLogin_(p) {
  return { ok: checkPassword_(p.password) };
}

function actionChangePassword_(p) {
  if (!checkPassword_(p.oldPassword)) return { ok: false, error: '기존 비밀번호가 틀렸어요.' };
  PropertiesService.getScriptProperties().setProperty('TEACHER_PASSWORD', p.newPassword);
  return { ok: true };
}

function actionCreateExam_(p) {
  if (!checkPassword_(p.password)) return { ok: false, error: '로그인이 필요해요.' };
  let fileId = '', pdfUrl = '';
  if (p.pdfBase64) {
    const folder = getOrCreateFolder_();
    const bytes = Utilities.base64Decode(p.pdfBase64);
    const blob = Utilities.newBlob(bytes, 'application/pdf', (p.filename || 'exam') + '.pdf');
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    fileId = file.getId();
    pdfUrl = 'https://drive.google.com/uc?export=download&id=' + fileId;
  }
  const answersCell = (p.answers || []).join(',');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_EXAMS);
  sheet.appendRow([p.id, p.title, answersCell, new Date().toISOString(), fileId, pdfUrl, '',
    p.sourceQuestionIds ? JSON.stringify(p.sourceQuestionIds) : '',
    p.composeRecipe ? JSON.stringify(p.composeRecipe) : '']);
  return { ok: true, id: p.id, pdfUrl: pdfUrl };
}

// 시험의 정답 배열 (주관식 문항은 '-'로 표시되어 있고, 자동 채점에서 빠진다)
function examAnswers_(row) {
  return String(row[2]).split(',').filter(String);
}
function isSubjective_(a) { return String(a) === '-'; }
// 객관식 정답 비율을 100점 만점으로 환산 (예: 25문항 중 22개 → 88점). 객관식이 없으면 0
function score100_(score, total) { return total > 0 ? Math.round(score / total * 100) : 0; }

function subjectiveNumbers_(answers) {
  const out = [];
  answers.forEach(function (a, i) { if (isSubjective_(a)) out.push(i + 1); });
  return out;
}

function findExamRow_(sheet, examId) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(examId)) return { rowIndex: i + 1, row: data[i] };
  }
  return null;
}

function actionListExams_(p) {
  if (!checkPassword_(p.password)) return { ok: false, error: '로그인이 필요해요.' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const examsData = ss.getSheetByName(SHEET_EXAMS).getDataRange().getValues();
  const scoresData = ss.getSheetByName(SHEET_SCORES).getDataRange().getValues();

  const countByExam = {};
  for (let i = 1; i < scoresData.length; i++) {
    const eid = String(scoresData[i][0]);
    countByExam[eid] = (countByExam[eid] || 0) + 1;
  }

  const exams = [];
  for (let i = 1; i < examsData.length; i++) {
    const row = examsData[i];
    exams.push({
      id: row[0], title: row[1],
      answerCount: examAnswers_(row).length,
      subjectiveCount: subjectiveNumbers_(examAnswers_(row)).length,
      createdAt: row[3], pdfUrl: row[5],
      hasRecipe: !!row[8],
      submissionCount: countByExam[String(row[0])] || 0,
    });
  }
  exams.reverse();  // 최신 순
  return { ok: true, exams: exams };
}

function actionGetExamPublic_(p) {
  // 학생용: 정답은 절대 내려주지 않고, 문항 수만 알려준다.
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const found = findExamRow_(ss.getSheetByName(SHEET_EXAMS), p.id);
  if (!found) return { ok: false, error: '존재하지 않는 시험이에요.' };
  const answers = examAnswers_(found.row);
  return { ok: true, title: found.row[1], answerCount: answers.length, subjective: subjectiveNumbers_(answers) };
}

function actionGetExamDetail_(p) {
  if (!checkPassword_(p.password)) return { ok: false, error: '로그인이 필요해요.' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const found = findExamRow_(ss.getSheetByName(SHEET_EXAMS), p.id);
  if (!found) return { ok: false, error: '존재하지 않는 시험이에요.' };

  const scoresData = ss.getSheetByName(SHEET_SCORES).getDataRange().getValues();
  const submissions = [];
  for (let i = 1; i < scoresData.length; i++) {
    if (String(scoresData[i][0]) === String(p.id)) {
      submissions.push({
        studentName: scoresData[i][1], answers: scoresData[i][2],
        score: scoresData[i][3], total: scoresData[i][4], submittedAt: scoresData[i][5],
        score100: (scoresData[i][6] === '' || scoresData[i][6] === undefined) ? (Number(scoresData[i][4]) ? Math.round(Number(scoresData[i][3]) / Number(scoresData[i][4]) * 100) : 0) : Number(scoresData[i][6]),
      });
    }
  }
  submissions.reverse();

  return {
    ok: true, id: found.row[0], title: found.row[1],
    answers: examAnswers_(found.row),
    createdAt: found.row[3], pdfUrl: found.row[5], explUrl: found.row[6] || '',
    sourceQuestionIds: found.row[7] ? JSON.parse(found.row[7]) : [],
    composeRecipe: found.row[8] ? JSON.parse(found.row[8]) : null,
    submissions: submissions,
  };
}

function actionSubmitAnswer_(p) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const found = findExamRow_(ss.getSheetByName(SHEET_EXAMS), p.id);
  if (!found) return { ok: false, error: '존재하지 않는 시험이에요.' };

  const correctAnswers = examAnswers_(found.row);
  const studentAnswers = p.answers || [];
  let score = 0, objective = 0;
  for (let i = 0; i < correctAnswers.length; i++) {
    if (isSubjective_(correctAnswers[i])) continue;      // 주관식은 자동 채점에서 뺀다
    objective++;
    if (String(studentAnswers[i]) === String(correctAnswers[i])) score++;
  }

  // 100점 만점 환산 (객관식만 채점, 주관식은 합산하지 않음)
  const score100 = objective ? Math.round(score / objective * 100) : 0;

  const scoresSheet = ss.getSheetByName(SHEET_SCORES);
  scoresSheet.appendRow([
    p.id, p.studentName || '이름없음', studentAnswers.join(','),
    score, objective, new Date().toISOString(), score100,
  ]);

  return {
    ok: true, score: score, total: objective, score100: score100, subjective: subjectiveNumbers_(correctAnswers),
    correctAnswers: correctAnswers, studentAnswers: studentAnswers,
    explUrl: found.row[6] || '',
  };
}


// ────────────── 문제은행 ──────────────
function questionsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ensureSheet_(ss, SHEET_QUESTIONS, ['id', 'unit', 'answer', 'source', 'textPreview', 'createdAt', 'fileId']);
}

function actionSaveQuestions_(p) {
  if (!checkPassword_(p.password)) return { ok: false, error: '로그인이 필요해요.' };
  const folder = getBankFolder_();
  const sheet = questionsSheet_();
  const rows = [];
  (p.questions || []).forEach(function (q) {
    const blob = Utilities.newBlob(Utilities.base64Decode(q.imageBase64), 'image/png', q.id + '.png');
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    let explId = '';
    if (q.explBase64) {
      const eb = Utilities.newBlob(Utilities.base64Decode(q.explBase64), 'image/png', q.id + '_expl.png');
      const ef = folder.createFile(eb);
      ef.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      explId = ef.getId();
    }
    rows.push([q.id, q.unit, q.answer || '', q.source || '', q.textPreview || '', new Date().toISOString(), file.getId(), explId, q.difficulty || '', (q.diffScore === undefined || q.diffScore === null) ? '' : q.diffScore,
      q.numRect ? JSON.stringify(q.numRect) : '', q.explNumRect ? JSON.stringify(q.explNumRect) : '']);
  });
  if (rows.length) {
    // 여러 저장 요청이 동시에 와도 행이 겹쳐 쓰이지 않게, 시트에 쓰는 순간만 잠근다
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try { sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 12).setValues(rows); }
    finally { lock.releaseLock(); }
  }
  return { ok: true, saved: rows.length };
}

// 시트에 JSON 문자열로 저장한 [x0,top,x1,bottom]을 배열로 읽는다 (없거나 깨졌으면 null)
function parseRect_(v) {
  if (!v) return null;
  try { const a = JSON.parse(v); return (Array.isArray(a) && a.length === 4 && a.every(function (n) { return isFinite(n); })) ? a : null; } catch (e) { return null; }
}

function actionListQuestions_(p) {
  if (!checkPassword_(p.password)) return { ok: false, error: '로그인이 필요해요.' };
  const data = questionsSheet_().getDataRange().getValues();
  const questions = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    questions.push({ id: r[0], unit: r[1], answer: String(r[2]), source: r[3], textPreview: r[4], createdAt: r[5], fileId: r[6], explFileId: r[7] || '', difficulty: r[8] || '', diffScore: (r[9] === '' || r[9] === undefined) ? null : Number(r[9]),
      numRect: parseRect_(r[10]), explNumRect: parseRect_(r[11]) });
  }
  return { ok: true, questions: questions };
}

function findQuestionRow_(sheet, id) {
  const ids = sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), 1).getValues();
  for (let i = 1; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 1;
  return -1;
}

function actionUpdateQuestion_(p) {
  if (!checkPassword_(p.password)) return { ok: false, error: '로그인이 필요해요.' };
  const sheet = questionsSheet_();
  const row = findQuestionRow_(sheet, p.id);
  if (row < 0) return { ok: false, error: '문항을 찾을 수 없어요.' };
  if (p.unit !== undefined) sheet.getRange(row, 2).setValue(p.unit);
  if (p.answer !== undefined) sheet.getRange(row, 3).setValue(String(p.answer));
  if (p.difficulty !== undefined) sheet.getRange(row, 9).setValue(String(p.difficulty));
  return { ok: true };
}

function actionDeleteQuestion_(p) {
  if (!checkPassword_(p.password)) return { ok: false, error: '로그인이 필요해요.' };
  const sheet = questionsSheet_();
  const row = findQuestionRow_(sheet, p.id);
  if (row < 0) return { ok: true };
  const fileId = sheet.getRange(row, 7).getValue();
  try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) {}
  const explId = sheet.getRange(row, 8).getValue();
  if (explId) { try { DriveApp.getFileById(explId).setTrashed(true); } catch (e) {} }
  sheet.deleteRow(row);
  return { ok: true };
}

function actionGetQuestionImages_(p) {
  if (!checkPassword_(p.password)) return { ok: false, error: '로그인이 필요해요.' };
  const images = (p.fileIds || []).map(function (fid) {
    const blob = DriveApp.getFileById(fid).getBlob();
    return { fileId: fid, base64: Utilities.base64Encode(blob.getBytes()) };
  });
  return { ok: true, images: images };
}


// 시험에 해설지 PDF를 붙인다 (시험 등록 직후 호출)
function actionAttachExplanation_(p) {
  if (!checkPassword_(p.password)) return { ok: false, error: '로그인이 필요해요.' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_EXAMS);
  const found = findExamRow_(sheet, p.id);
  if (!found) return { ok: false, error: '존재하지 않는 시험이에요.' };
  const blob = Utilities.newBlob(Utilities.base64Decode(p.explBase64), 'application/pdf', (p.filename || 'exam') + '_해설.pdf');
  const file = getOrCreateFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const url = 'https://drive.google.com/file/d/' + file.getId() + '/view';
  sheet.getRange(found.rowIndex, 7).setValue(url);
  return { ok: true, explUrl: url };
}


// 여러 문항의 단원·정답·난이도를 한 번에 바꾼다.
// 문항 수와 상관없이 시트 접근은 "읽기 1번 + 쓰기 최대 2번"이라 빠르다.
// updates: [{id, unit?, answer?, difficulty?}, ...]
// 문항 수가 아무리 많아도(수백~수천), 이 함수의 속도는 "이번에 바뀐 문항 수"에만 좌우되게 만든다.
// 예전에는 정답 하나만 고쳐도 전체 시트를 통째로 다시 썼는데, 그러면 문항이 많아질수록 느려졌다.
function actionUpdateQuestions_(p) {
  if (!checkPassword_(p.password)) return { ok: false, error: '로그인이 필요해요.' };
  const updates = p.updates || [];
  if (!updates.length) return { ok: true, updated: 0 };
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = questionsSheet_();
    const last = sheet.getLastRow();
    if (last < 2) return { ok: true, updated: 0 };
    // id는 A열 하나만 읽어서 각 id가 몇 번째 행인지만 파악한다 (전체 9열을 읽지 않음)
    const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
    const rowOf = {};
    for (let i = 0; i < ids.length; i++) rowOf[String(ids[i][0])] = i + 2;

    const BULK_THRESHOLD = 30;  // 자동분류처럼 한 번에 많이 바뀔 때만 "전체 다시 쓰기" 방식을 쓴다
    let n = 0;
    if (updates.length > BULK_THRESHOLD) {
      const data = sheet.getRange(2, 1, last - 1, 9).getValues();
      const idxOf = {};
      for (let i = 0; i < data.length; i++) idxOf[String(data[i][0])] = i;
      let ua = false, df = false;
      updates.forEach(function (u) {
        const i = idxOf[String(u.id)];
        if (i === undefined) return;
        if (u.unit !== undefined) { data[i][1] = String(u.unit); ua = true; }
        if (u.answer !== undefined) { data[i][2] = String(u.answer); ua = true; }
        if (u.difficulty !== undefined) { data[i][8] = String(u.difficulty); df = true; }
        n++;
      });
      if (ua) sheet.getRange(2, 2, data.length, 2).setValues(data.map(function (r) { return [r[1], r[2]]; }));
      if (df) sheet.getRange(2, 9, data.length, 1).setValues(data.map(function (r) { return [r[8]]; }));
    } else {
      // 바뀐 행만 콕 집어서 쓴다 → 문제은행 전체 크기와 상관없이 항상 빠르다
      updates.forEach(function (u) {
        const row = rowOf[String(u.id)];
        if (!row) return;
        if (u.unit !== undefined) sheet.getRange(row, 2).setValue(String(u.unit));
        if (u.answer !== undefined) sheet.getRange(row, 3).setValue(String(u.answer));
        if (u.difficulty !== undefined) sheet.getRange(row, 9).setValue(String(u.difficulty));
        n++;
      });
    }
    return { ok: true, updated: n };
  } finally {
    lock.releaseLock();
  }
}

// ────────────── 문항 구성 프리셋 (기초/기본/심화의 상·중·하 %) ──────────────
function actionGetPresets_(p) {
  if (!checkPassword_(p.password)) return { ok: false, error: '로그인이 필요해요.' };
  const raw = PropertiesService.getScriptProperties().getProperty('PRESETS');
  let presets = null;
  try { presets = raw ? JSON.parse(raw) : null; } catch (e) {}
  return { ok: true, presets: presets };
}

function actionSetPresets_(p) {
  if (!checkPassword_(p.password)) return { ok: false, error: '로그인이 필요해요.' };
  const clean = {};
  const src = p.presets || {};
  Object.keys(src).forEach(function (name) {
    const v = src[name] || {};
    const row = { '상': Number(v['상']), '중': Number(v['중']), '하': Number(v['하']) };
    if (['상', '중', '하'].some(function (k) { return !isFinite(row[k]) || row[k] < 0; })) return;
    clean[String(name)] = row;
  });
  if (!Object.keys(clean).length) return { ok: false, error: '저장할 프리셋이 없어요.' };
  PropertiesService.getScriptProperties().setProperty('PRESETS', JSON.stringify(clean));
  return { ok: true, presets: clean };
}


// ────────────── 시험기록(제출 내역) 관리 ──────────────
// 제출 행에는 별도 id가 없어서, (시험id + 학생이름 + 제출시각)을 고유 키로 써서 찾는다.
// 제출시각은 초 단위까지 기록되므로 사실상 겹치지 않는다.
function findSubmissionRow_(sheet, examId, studentName, submittedAt) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(examId) && String(data[i][1]) === String(studentName) && String(data[i][5]) === String(submittedAt)) {
      return { rowIndex: i + 1, row: data[i] };
    }
  }
  return null;
}

function actionListSubmissions_(p) {
  if (!checkPassword_(p.password)) return { ok: false, error: '로그인이 필요해요.' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const examsData = ss.getSheetByName(SHEET_EXAMS).getDataRange().getValues();
  const examOf = {};
  for (let i = 1; i < examsData.length; i++) {
    const row = examsData[i];
    examOf[String(row[0])] = {
      title: row[1], correctAnswers: examAnswers_(row),
      sourceQuestionIds: row[7] ? JSON.parse(row[7]) : [],
    };
  }

  const scoresData = ss.getSheetByName(SHEET_SCORES).getDataRange().getValues();
  const subs = [];
  for (let i = 1; i < scoresData.length; i++) {
    const r = scoresData[i];
    const ex = examOf[String(r[0])];
    subs.push({
      examId: r[0], examTitle: ex ? ex.title : '(삭제된 시험)', studentName: r[1],
      answers: r[2], score: r[3], total: r[4], submittedAt: r[5],
      score100: (r[6] === '' || r[6] === undefined) ? score100_(Number(r[3]), Number(r[4])) : Number(r[6]),
      correctAnswers: ex ? ex.correctAnswers : [],
      sourceQuestionIds: ex ? ex.sourceQuestionIds : [],
    });
  }
  subs.reverse();  // 최신 순
  return { ok: true, submissions: subs };
}

function actionDeleteSubmission_(p) {
  if (!checkPassword_(p.password)) return { ok: false, error: '로그인이 필요해요.' };
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SCORES);
  const found = findSubmissionRow_(sheet, p.examId, p.studentName, p.submittedAt);
  if (!found) return { ok: false, error: '기록을 찾을 수 없어요. (이미 삭제되었거나 목록이 바뀌었을 수 있어요)' };
  sheet.deleteRow(found.rowIndex);
  return { ok: true };
}

function actionUpdateSubmissionScore_(p) {
  if (!checkPassword_(p.password)) return { ok: false, error: '로그인이 필요해요.' };
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SCORES);
  const found = findSubmissionRow_(sheet, p.examId, p.studentName, p.submittedAt);
  if (!found) return { ok: false, error: '기록을 찾을 수 없어요. (이미 삭제되었거나 목록이 바뀌었을 수 있어요)' };
  const score = Math.max(0, parseInt(p.score, 10) || 0);
  const total = Math.max(0, parseInt(p.total, 10) || 0);
  if (total > 0 && score > total) return { ok: false, error: '정답 수가 전체 문항 수보다 클 수 없어요.' };
  const s100 = score100_(score, total);
  sheet.getRange(found.rowIndex, 4, 1, 4).setValues([[score, total, found.row[5], s100]]);
  return { ok: true, score: score, total: total, score100: s100 };
}


// 문제은행 문항 여러 개를 한 번에 지운다 (한 개씩 지우는 것보다 훨씬 빠르다 — 행을 뒤에서부터
// 지워서 번호가 밀리는 문제를 피한다)
function actionDeleteQuestions_(p) {
  if (!checkPassword_(p.password)) return { ok: false, error: '로그인이 필요해요.' };
  const ids = p.ids || [];
  if (!ids.length) return { ok: true, deleted: 0 };
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = questionsSheet_();
    const last = sheet.getLastRow();
    if (last < 2) return { ok: true, deleted: 0 };
    const data = sheet.getRange(2, 1, last - 1, 8).getValues();
    const want = {}; ids.forEach(function (id) { want[String(id)] = true; });
    const rowsToDelete = [];
    for (let i = 0; i < data.length; i++) {
      if (!want[String(data[i][0])]) continue;
      rowsToDelete.push(i + 2);
      const fileId = data[i][6], explId = data[i][7];
      if (fileId) { try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) {} }
      if (explId) { try { DriveApp.getFileById(explId).setTrashed(true); } catch (e) {} }
    }
    rowsToDelete.sort(function (a, b) { return b - a; }).forEach(function (r) { sheet.deleteRow(r); });
    return { ok: true, deleted: rowsToDelete.length };
  } finally {
    lock.releaseLock();
  }
}

// 등록된 시험지를 지운다 (PDF/해설 파일 + 제출 기록까지 함께 정리)
function actionDeleteExam_(p) {
  if (!checkPassword_(p.password)) return { ok: false, error: '로그인이 필요해요.' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const examsSheet = ss.getSheetByName(SHEET_EXAMS);
  const found = findExamRow_(examsSheet, p.id);
  if (!found) return { ok: false, error: '존재하지 않는 시험이에요.' };
  const fileId = found.row[4];
  if (fileId) { try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) {} }
  examsSheet.deleteRow(found.rowIndex);

  let removedScores = 0;
  if (p.deleteSubmissions) {
    const scoresSheet = ss.getSheetByName(SHEET_SCORES);
    const data = scoresSheet.getDataRange().getValues();
    for (let i = data.length - 1; i >= 1; i--) {
      if (String(data[i][0]) === String(p.id)) { scoresSheet.deleteRow(i + 1); removedScores++; }
    }
  }
  return { ok: true, removedScores: removedScores };
}
