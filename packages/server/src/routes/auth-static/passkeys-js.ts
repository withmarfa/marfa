/** Browser WebAuthn ceremonies. Credentials stay in the browser's authenticator. */
export const PASSKEYS_JS = `(() => {
  const status = document.getElementById('passkey-status');
  const add = document.getElementById('add-passkey');
  const list = document.getElementById('passkeys');
  const supported = window.isSecureContext && window.PublicKeyCredential &&
    PublicKeyCredential.parseCreationOptionsFromJSON && PublicKeyCredential.parseRequestOptionsFromJSON;
  if (!supported) {
    status.textContent = 'Passkeys need a supported browser and a secure HTTPS address (or localhost for development).';
    if (add) add.disabled = true;
  }
  async function answer(send, why) {
    const response = await (why ? window.marfaConfirm.send(send, why) : send());
    if (response === null) throw Object.assign(new Error('Nothing was changed.'), { cancelled: true });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || data.message || 'The passkey request could not be completed. Try again.');
    return data;
  }
  function request(path, body, method = body === undefined ? 'GET' : 'POST', why) {
    return answer(() => fetch(path.startsWith('/') ? path : '/auth/passkey/' + path, {
      method, credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }), why);
  }
  async function run(button, work) {
    button.disabled = true; status.textContent = '';
    try { await work(); }
    catch (error) {
      status.textContent = error.cancelled ? '' : error.name === 'NotAllowedError' || error.name === 'AbortError'
        ? 'The passkey request was cancelled or timed out. You can try again.'
        : error.message || 'The passkey request could not be completed. Try again.';
    } finally { button.disabled = false; }
  }
  async function refresh() {
    const { data: rows } = await request('/owner/passkeys');
    list.replaceChildren();
    for (const row of rows) {
      const item = document.createElement('li');
      const label = document.createElement('span'); label.textContent = row.name || 'Passkey';
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
      remove.addEventListener('click', () => run(remove, async () => {
        await request('/owner/passkeys/' + encodeURIComponent(row.id), undefined, 'DELETE', 'Removing a passkey needs a recent sign-in.'); await refresh(); status.textContent = 'Passkey removed.';
      }));
      item.append(label, ' ', remove); list.append(item);
    }
    if (!rows.length) { const empty = document.createElement('li'); empty.textContent = 'No passkeys yet.'; list.append(empty); }
  }
  if (add) add.addEventListener('click', () => run(add, async () => {
    const name = document.querySelector('[name="passkey-name"]').value.trim();
    const why = 'Adding a passkey needs a recent sign-in.';
    const create = async (asking) => {
      const options = await request('generate-register-options', undefined, 'GET', asking);
      const made = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) });
      if (!made) throw new Error('No passkey was created. Try again.');
      return made;
    };
    let credential = await create(why);
    // A confirmation, answered with a passkey, replaces the challenge this
    // registration was made for, so the registration starts again from its
    // options. One answered with the password leaves the credential good to send.
    await answer(async (confirmedWith) => {
      if (confirmedWith === 'passkey') credential = await create();
      return fetch('/auth/passkey/verify-registration', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response: credential.toJSON(), name })
      });
    }, why);
    await refresh(); status.textContent = 'Passkey added.';
  }));
  if (list) refresh().catch(error => { status.textContent = error.message; });
})();`;
