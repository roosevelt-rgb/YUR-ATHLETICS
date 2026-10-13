document.getElementById('splashBoot').textContent = 'Code Glider · IntelliFlow · YUR AI Desktop';
const button = document.createElement('button'); button.textContent = 'ENTER WORKBENCH'; button.style.cssText = 'margin-top:24px;padding:12px 24px;border:1px solid #777;cursor:pointer';
button.onclick = async () => { button.disabled = true; try { await window.studio.launch.enter(); } catch (e) { button.disabled = false; document.getElementById('splashBoot').textContent = e.message; } };
document.querySelector('.splash-core').append(button);
