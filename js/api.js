// Apps Script 웹앱 호출 헬퍼.
// Content-Type을 지정하지 않아야(text/plain 기본값) CORS preflight 없이 바로 호출된다.
async function callApi(action, params) {
  const payload = Object.assign({ action: action }, params || {});
  const res = await fetch(window.APP_CONFIG.API_URL, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error('서버 요청에 실패했어요 (' + res.status + ')');
  }
  return res.json();
}

function getTeacherPassword() {
  return sessionStorage.getItem('teacher_pw') || '';
}

function requireLogin() {
  if (!getTeacherPassword()) {
    location.href = 'teacher_login.html';
  }
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' +
    String(d.getDate()).padStart(2, '0') + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}


// 100점 만점 환산 (객관식 정답 수 / 객관식 문항 수). 객관식이 없으면 null
function to100(score, total) {
  return Number(total) > 0 ? Math.round(Number(score) / Number(total) * 100) : null;
}
