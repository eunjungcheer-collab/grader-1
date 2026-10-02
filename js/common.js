function renderHeader(opts) {
  const isLoggedIn = !!getTeacherPassword();
  const authHtml = isLoggedIn ? `
    <div class="topbar-auth">
      <a href="teacher_change_password.html" class="logout-link">비밀번호 변경</a>
      <span class="topbar-divider">|</span>
      <a href="#" id="logout-link" class="logout-link">로그아웃</a>
    </div>` : '';

  document.body.insertAdjacentHTML('afterbegin', `
    <div class="wrap${opts && opts.wide ? ' wide' : ''}${opts && opts.wider ? ' wider' : ''}">
      <header class="topbar">
        <div class="topbar-inner">
          <a href="index.html" class="brand">📝 자동채점 시스템</a>
          ${authHtml}
        </div>
      </header>
      <main id="main-content"></main>
    </div>
  `);

  const logoutLink = document.getElementById('logout-link');
  if (logoutLink) {
    logoutLink.addEventListener('click', function (e) {
      e.preventDefault();
      sessionStorage.removeItem('teacher_pw');
      location.href = 'teacher_login.html';
    });
  }

  // 페이지 본문(<body> 안에 미리 넣어둔 template#page-content)을 main으로 옮긴다.
  const tpl = document.getElementById('page-content');
  if (tpl) {
    document.getElementById('main-content').appendChild(tpl.content.cloneNode(true));
    tpl.remove();
  }
}
