// Cognitive Friction v2 - Content Script

const TRIGGER_KEYWORDS = [
  '帮我写','帮我总结','帮我生成','帮我做','帮我分析','帮我解释','帮我翻译',
  '给我写','给我总结','帮忙写','帮忙总结','总结一下',
  'help me write','help me summarize','summarize this','summarize the',
  'write me a','write a ','generate a','generate me',
  'can you write','can you summarize','please write','please summarize',
  'explain this','tldr','tl;dr'
];

let apiKey = '';
let overlayActive = false;
let bypassNext = false;

chrome.storage.sync.get(['apiKey'], r => { apiKey = r.apiKey || ''; });
chrome.storage.onChanged.addListener(c => { if (c.apiKey) apiKey = c.apiKey.newValue; });

// ── Site config ───────────────────────────────────────────────────

function getSite() {
  const h = location.hostname;
  if (h.includes('claude.ai')) return {
    name: 'claude',
    inputSel: '[contenteditable="true"][data-placeholder]',
    submitSel: 'button[aria-label="Send message"],button[type="submit"]',
  };
  if (h.includes('chatgpt.com')) return {
    name: 'chatgpt',
    inputSel: '#prompt-textarea,[contenteditable="true"]',
    submitSel: 'button[data-testid="send-button"],button[aria-label="Send prompt"]',
  };
  if (h.includes('gemini.google.com')) return {
    name: 'gemini',
    inputSel: 'rich-textarea div[contenteditable="true"]',
    submitSel: 'button[aria-label="Send message"],button.send-button',
  };
  return null;
}

function getInputEl() {
  const s = getSite();
  return s ? document.querySelector(s.inputSel) : null;
}

function getInputText(el) {
  return (el?.innerText || el?.value || '').trim();
}

function setInputText(el, text) {
  if (!el) return;
  el.focus();
  if (el.isContentEditable) {
    el.innerText = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  } else {
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    nativeSet.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function getHistory() {
  const site = getSite();
  const msgs = [];
  if (site?.name === 'claude') {
    document.querySelectorAll('[data-testid="human-turn"],[data-testid="ai-turn"]').forEach(el => {
      msgs.push({ role: el.dataset.testid === 'human-turn' ? 'user' : 'assistant', text: el.innerText.trim().slice(0, 500) });
    });
  } else if (site?.name === 'chatgpt') {
    document.querySelectorAll('[data-message-author-role]').forEach(el => {
      msgs.push({ role: el.dataset.messageAuthorRole, text: el.innerText.trim().slice(0, 500) });
    });
  } else if (site?.name === 'gemini') {
    document.querySelectorAll('.user-query,.model-response-text').forEach(el => {
      msgs.push({ role: el.classList.contains('user-query') ? 'user' : 'assistant', text: el.innerText.trim().slice(0, 500) });
    });
  }
  return msgs.slice(-12);
}

// ── API via background (bypasses CSP) ────────────────────────────

function callAPI(system, user) {
  return new Promise((resolve) => {
    if (!apiKey) { resolve(null); return; }
    chrome.runtime.sendMessage(
      { type: 'CF_API', apiKey, system, user },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error('[CF]', chrome.runtime.lastError);
          resolve(null);
        } else {
          resolve(response?.text || null);
        }
      }
    );
  });
}

// ── Prompt generators ─────────────────────────────────────────────

async function generateReflectionData(prompt) {
  const raw = await callAPI(
    `You help users reflect before getting AI help. Given a user's prompt, return JSON only (no markdown):
{"question":"one Socratic question in same language as prompt","outline":["3-4 short bullet points of what to think about"]}`,
    `User prompt: "${prompt.slice(0, 400)}"`
  );
  if (!raw) return null;
  try { return JSON.parse(raw.replace(/```json|```/g,'').trim()); } catch { return null; }
}

function buildEnhancedPrompt(originalPrompt, userThought) {
  if (!userThought) return originalPrompt;
  const sep = "\n\n";
  const lang = /[一-龥]/.test(originalPrompt) ? "zh" : "en";
  if (lang === "zh") {
    return originalPrompt + sep + "（我目前的想法是：" + userThought + "）";
  } else {
    return originalPrompt + sep + "(My initial thoughts: " + userThought + ")";
  }
}

async function generateQuiz(history) {
  const context = history.map(m => `${m.role}: ${m.text}`).join('\n');
  const randomSeed = Math.random().toString(36).slice(2, 8);
  const raw = await callAPI(
    `Based on this conversation, generate a multiple choice question. First infer the user's task type:
- If writing/drafting (related work, essay, report): ask about structure, logic, angle, or coverage of the writing task
- If learning/understanding a concept: ask about the concept itself
- If problem-solving/coding: ask about the approach or reasoning
- If analyzing: ask about the analytical framework used

Generate a DIFFERENT question each time (seed: ${randomSeed}). Return JSON only (no markdown):
{"type":"choice","question":"targeted question based on task type","options":["A. ...","B. ...","C. ...","D. ..."],"correct":"A"}
Use same language as conversation. Be specific to what was actually discussed.`,
    `Conversation:\n${context}`
  );
  if (!raw) return null;
  try { return JSON.parse(raw.replace(/```json|```/g,'').trim()); } catch { return null; }
}

// ── Intercept overlay ─────────────────────────────────────────────

function showInterceptOverlay(originalPrompt) {
  if (overlayActive) return;
  overlayActive = true;

  const backdrop = mkEl('div','cf-backdrop');
  const card = mkEl('div','cf-card');
  card.innerHTML = `
    <div class="cf-header">
      <span class="cf-label">⏸ 先想一想</span>
      <button class="cf-x">✕</button>
    </div>
    <div class="cf-loading"><div class="cf-spinner"></div><span>分析中…</span></div>
    <div class="cf-body" style="display:none">
      <p class="cf-question" id="cf-q"></p>
      <ul class="cf-outline" id="cf-ol"></ul>
      <textarea class="cf-textarea" placeholder="你的思考（可留空跳过）…" rows="3"></textarea>
      <div class="cf-actions">
        <button class="cf-btn-ghost">跳过，直接发原问题</button>
        <button class="cf-btn-primary">整合后注入输入框 →</button>
      </div>
    </div>`;
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('cf-visible'));

  const close = () => {
    backdrop.classList.add('cf-fade-out');
    setTimeout(() => { backdrop.remove(); overlayActive = false; }, 250);
  };

  card.querySelector('.cf-x').onclick = close;

  generateReflectionData(originalPrompt).then(data => {
    card.querySelector('.cf-loading').style.display = 'none';
    const body = card.querySelector('.cf-body');
    body.style.display = 'block';

    card.querySelector('#cf-q').textContent = data?.question || '你对这个话题已有哪些了解？';
    (data?.outline || []).forEach(item => {
      const li = document.createElement('li');
      li.textContent = item;
      card.querySelector('#cf-ol').appendChild(li);
    });

    const textarea = card.querySelector('.cf-textarea');
    textarea.focus();

    card.querySelector('.cf-btn-ghost').onclick = close;

    card.querySelector('.cf-btn-primary').onclick = async () => {
      const thought = textarea.value.trim();
      const btn = card.querySelector('.cf-btn-primary');
      btn.textContent = '整合中…';
      btn.disabled = true;
      const enhanced = buildEnhancedPrompt(originalPrompt, thought);
      close();
      setTimeout(() => {
        const el = getInputEl();
        if (el) { bypassNext = true; setInputText(el, enhanced); }
      }, 350);
    };
  });
}

// ── Quiz overlay ──────────────────────────────────────────────────

function showQuizOverlay(quiz) {
  if (overlayActive) return;
  overlayActive = true;

  const isChoice = quiz.type === 'choice' && quiz.options?.length;
  const backdrop = mkEl('div','cf-backdrop');
  const card = mkEl('div','cf-card');

  const optHtml = isChoice
    ? `<div class="cf-options">${quiz.options.map((o,i)=>`<button class="cf-option" data-idx="${i}">${o}</button>`).join('')}</div>`
    : `<textarea class="cf-textarea" placeholder="写下你的回答…" rows="4"></textarea>`;

  card.innerHTML = `
    <div class="cf-header">
      <span class="cf-label">🧠 理解测试</span>
      <button class="cf-x">✕</button>
    </div>
    <p class="cf-question">${quiz.question}</p>
    ${optHtml}
    <div class="cf-feedback" style="display:none"></div>
    <div class="cf-actions" id="cf-qa">
      ${isChoice ? '' : '<button class="cf-btn-ghost">跳过</button><button class="cf-btn-primary">发送给AI验证 →</button>'}
    </div>`;

  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('cf-visible'));

  const close = () => {
    backdrop.classList.add('cf-fade-out');
    setTimeout(() => { backdrop.remove(); overlayActive = false; }, 250);
  };

  const sendToAI = (ans) => {
    const prompt = `[理解测试回答]\n题目：${quiz.question}\n我的回答：${ans}\n\n请评价我的回答，指出对错并补充解释。`;
    close();
    setTimeout(() => { const el = getInputEl(); if (el) { bypassNext = true; setInputText(el, prompt); } }, 350);
  };

  card.querySelector('.cf-x').onclick = close;

  if (isChoice) {
    const letters = ['A','B','C','D'];
    card.querySelectorAll('.cf-option').forEach((btn, i) => {
      btn.onclick = async () => {
        card.querySelectorAll('.cf-option').forEach(b => b.disabled = true);
        const isCorrect = letters[i] === quiz.correct || quiz.options[i]?.startsWith(quiz.correct);
        btn.classList.add(isCorrect ? 'cf-correct' : 'cf-wrong');
        if (!isCorrect) {
          const ci = letters.indexOf(quiz.correct);
          if (ci >= 0) card.querySelectorAll('.cf-option')[ci]?.classList.add('cf-correct');
        }

        const fb = card.querySelector('.cf-feedback');
        fb.style.display = 'block';
        fb.className = `cf-feedback ${isCorrect ? 'cf-fb-ok' : 'cf-fb-err'}`;
        fb.textContent = isCorrect ? '✓ 正确！获取解释中…' : `✗ 正确答案是 ${quiz.correct}，获取解释中…`;

        const optionsText = quiz.options.join('\n');
        const explanation = await callAPI(
          '你是一个简洁的知识讲解助手，用同语言回答。',
          `题目：${quiz.question}\n选项：\n${optionsText}\n正确答案：${quiz.correct}\n用户选了：${quiz.options[i]}\n\n用2-3句话解释为什么正确答案是${quiz.correct}，要具体针对题目内容。`
        );

        fb.textContent = (isCorrect ? '✓ 正确！\n' : `✗ 正确答案是 ${quiz.correct}\n`) + (explanation || '');
        fb.style.whiteSpace = 'pre-wrap';

        const actions = card.querySelector('#cf-qa');
        const fullContext = `题目：${quiz.question}\n\n选项：\n${optionsText}\n\n正确答案：${quiz.correct}\n我的回答：${quiz.options[i]}\n\n请进一步深入解释这个知识点。`;
        actions.innerHTML = `<button class="cf-btn-ghost">关闭</button><button class="cf-btn-primary">进一步深入 →</button>`;
        actions.querySelector('.cf-btn-ghost').onclick = close;
        actions.querySelector('.cf-btn-primary').onclick = () => {
          close();
          setTimeout(() => { const el = getInputEl(); if (el) { bypassNext = true; setInputText(el, fullContext); } }, 350);
        };
      };
    });
  } else {
    card.querySelector('.cf-btn-ghost').onclick = close;
    card.querySelector('.cf-btn-primary').onclick = () => {
      sendToAI(card.querySelector('.cf-textarea').value.trim() || '（未作答）');
    };
  }
}

// ── Quiz button ───────────────────────────────────────────────────

function injectQuizBtn() {
  if (document.getElementById('cf-quiz-btn')) return;
  const btn = mkEl('button','');
  btn.id = 'cf-quiz-btn';
  btn.title = '测试你的理解';
  btn.textContent = '🧠';
  btn.onclick = async () => {
    if (overlayActive) return;
    btn.disabled = true; btn.textContent = '⏳';
    const history = getHistory();
    let quiz = null;
    if (history.length >= 2) {
      quiz = await generateQuiz(history);
    }
    btn.textContent = '🧠'; btn.disabled = false;
    showQuizOverlay(quiz || {
      type: 'choice',
      question: '通过这段对话，你主要获得了什么？',
      options: ['A. 了解了一个新概念', 'B. 解决了一个具体问题', 'C. 纠正了自己的误解', 'D. 获得了新的思路或框架'],
      correct: 'A'
    });
  };
  document.body.appendChild(btn);
}

// ── Submit intercept ──────────────────────────────────────────────

function shouldIntercept(text) {
  const l = text.toLowerCase();
  return TRIGGER_KEYWORDS.some(kw => l.includes(kw));
}

let pending = false;
function handleSubmit(e) {
  if (overlayActive || pending) return;
  if (bypassNext) { bypassNext = false; return; }
  const input = getInputEl();
  if (!input) return;
  const text = getInputText(input);
  if (!text || !shouldIntercept(text)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  pending = true;
  setTimeout(() => { pending = false; }, 1000);
  showInterceptOverlay(text);
}

document.addEventListener('keydown', e => { if (e.key==='Enter' && !e.shiftKey) handleSubmit(e); }, true);
document.addEventListener('click', e => {
  const s = getSite();
  if (s && e.target.closest(s.submitSel)) handleSubmit(e);
}, true);

// ── Helpers & init ────────────────────────────────────────────────

function mkEl(tag, cls) { const el=document.createElement(tag); if(cls) el.className=cls; return el; }

function init() { injectQuizBtn(); }
if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
else init();
new MutationObserver(injectQuizBtn).observe(document.body, { childList:true, subtree:true });
