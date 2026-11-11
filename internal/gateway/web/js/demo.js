// Demo tools use same-origin admin endpoints, so an SSH tunnel needs only 9090.
// User-provided response data is rendered as text, never interpreted as HTML.
import { el, toast, openModal } from './ui.js';
import { getConfig, putConfig } from './api.js';

async function call(path, body) {
  const response = await fetch(`/admin/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function field(label, control) {
  return el('label', { class: 'demo-field' }, el('span', { text: label }), control);
}
function button(text, onclick) { return el('button', { class: 'btn btn-sm', type: 'button', text, onclick }); }
function panel(id) { return document.querySelector(`#${id} .panel-body`); }

export function initDemo(store) {
  initPlayground();
  initRequests(store);
  initHistory(store);
}
function initPlayground() {
  const method = el('select', { class: 'rf-input', 'aria-label': 'Request method' }, ...['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].map(v => el('option', { text:v })));
  const path = el('input', { class:'rf-input', value:'/api/catalog/test', required:true, maxlength:1500 });
  const host = el('input', { class:'rf-input', value:'demo.local', maxlength:200 });
  const headers = el('textarea', { class:'rf-input', rows:2, placeholder:'{"X-Region":"eu"}' });
  const token = el('input', { class:'rf-input', type:'password', autocomplete:'off', placeholder:'Optional JWT; not saved' });
  const body = el('textarea', { class:'rf-input', rows:2, placeholder:'Optional request body' });
  const result = el('pre', { class:'demo-output', role:'status', text:'Send a request to inspect its response. Requests count in gateway metrics.' });
  const responseMeta = el('div', { class:'demo-response-meta', 'aria-live':'polite' });
  const send = el('button', { class:'btn btn-primary', type:'submit', text:'Send request →' });
  // Keep the common request path visible; advanced inputs remain one click away.
  const advanced = el('details', { class:'demo-advanced' }, el('summary', { text:'Headers, authentication & body' }),
    el('div', { class:'demo-form' },field('Match host',host),field('Bearer token',token),field('Headers (JSON object)',headers),field('Body',body)));
  const form = el('form', { class:'demo-form' }, field('Method',method), field('Gateway path',path), advanced,send);
  const examples = el('div', {class:'demo-examples'}, el('span', {text:'Try a request'}));
  for (const [label, endpoint, custom] of [['Catalog','/api/catalog/test',{}],['JWT check','/api/secure/test',{}],['EU inventory','/api/inventory/test',{'X-Region':'eu'}]]) {
    examples.append(button(label,()=>{method.value='GET';path.value=endpoint;headers.value=Object.keys(custom).length?JSON.stringify(custom,null,2):'';body.value='';if(Object.keys(custom).length)advanced.open=true;}));
  }
  form.addEventListener('submit', async e => {
    e.preventDefault(); send.disabled=true;send.textContent='Sending…';responseMeta.replaceChildren();result.textContent='Waiting for the gateway…';
    try {
      const h = headers.value.trim() ? JSON.parse(headers.value) : {};
      if (!h || Array.isArray(h) || typeof h !== 'object' || Object.values(h).some(v=>typeof v!=='string')) throw new Error('Headers must be an object with string values.');
      const data = await call('playground',{ method:method.value,path:path.value,host:host.value,headers:h,token:token.value.trim(),body:body.value });
      responseMeta.replaceChildren(
        el('span',{class:`demo-status demo-status-${Math.floor(data.status/100)}`,text:`HTTP ${data.status}`}),
        el('span',{text:`${data.duration_ms.toFixed(2)} ms`}),
        el('span',{text:`Route ${data.route || 'unmatched'}`}),
        el('span',{text:`Upstream ${data.upstream || '—'}`}),
        el('span',{text:`Revision ${data.revision || '—'}`}),
        el('span',{class:'demo-request-id',text:`ID ${data.request_id || '—'}`}));
      let content=data.body;
      try {content=JSON.stringify(JSON.parse(content),null,2);}catch {/* Plain-text upstream responses are valid too. */}
      result.textContent=content || '(Empty response body)';
      if(data.truncated)result.append('\n\nResponse preview truncated at 64 KiB.');
    } catch (e) { result.textContent=e.message; }
    finally { send.disabled=false;send.textContent='Send request →'; }
  });
  panel('playground').append(examples,form,el('p',{class:'demo-note',text:'Uses live routing and authentication. Write requests can change upstream data.'}),el('div',{class:'demo-response'},el('h3',{text:'Response'}),responseMeta,result));
}
function initRequests(store) {
  const route=el('input',{class:'rf-input',placeholder:'Filter by route', 'aria-label':'Filter by route'});
  const status=el('select',{class:'rf-input','aria-label':'Filter by status'},...['All statuses','2xx','3xx','4xx','5xx'].map(v=>el('option',{text:v})));
  const summary=el('p',{class:'demo-note',role:'status'});
  const body=el('tbody');
  const table=el('table',{class:'demo-table'},el('thead',{},el('tr',{},...['Time','Method','Route','Upstream','Status','Duration','Request ID','Revision'].map(text=>el('th',{text})))),body);
  let rows=[], paused=false, busy=false, ticks=0;
  const paint=()=> {
    const filtered=rows.filter(r=>(!route.value || r.route.includes(route.value)) && (status.selectedIndex===0 || Math.floor(r.status/100)===status.selectedIndex+1));
    body.replaceChildren(...filtered.map(r=>el('tr',{},...[new Date(r.time).toLocaleTimeString(),r.method,r.route||'unmatched',r.upstream||'—',r.status,`${r.duration_ms.toFixed(2)} ms`,r.request_id,r.revision].map((text,i)=>el('td',{class:i===6?'demo-id-cell':''},i===4?el('span',{class:`demo-status demo-status-${Math.floor(r.status/100)}`,text}):String(text))))));
    if(!filtered.length)body.append(el('tr',{},el('td',{colspan:8,class:'demo-empty',text:rows.length?'No requests match these filters.':'No requests yet. Send one from the playground or start traffic to see activity.'})));
    summary.textContent=`${filtered.length} shown / ${rows.length} retained. ${paused?'Viewing paused.':'Live, refreshed every 2 seconds.'} Metadata only; cleared on gateway restart.`;
  };
  const refresh=async()=> {
    if (busy || paused || document.hidden) return;
    busy=true;
    try { rows=(await call('requests')).requests;paint(); }
    catch(e) { summary.textContent=`Request log unavailable: ${e.message}`; }
    finally { busy=false; }
  };
  const pause=button('Pause viewing',()=>{paused=!paused;pause.textContent=paused?'Resume viewing':'Pause viewing';pause.setAttribute('aria-pressed',String(paused));paint();if(!paused)refresh();});
  route.addEventListener('input',paint);status.addEventListener('change',paint);
  panel('request-log').append(el('div',{class:'demo-toolbar'},route,status,pause),summary,el('div',{class:'demo-scroll'},table));
  store.subscribe(({type})=>{if(type==='frame' && ++ticks%2===0)refresh();});
  refresh();
}
function initHistory(store) {
  const list=el('div'); const summary=el('p',{class:'demo-note',role:'status'});
  let revision=null, busy=false;
  const refresh=async()=> {
    if(busy)return;busy=true;
    try {
      const [{history},active]=await Promise.all([call('history'),getConfig()]);
      revision=active.revision;
      summary.textContent='Up to 10 saved revisions. Restore creates a new revision. Finish or roll back any canary before restoring.';
      list.replaceChildren(...history.slice().reverse().map(h=>{
        const current=h.revision===active.revision;
        const view=button(current?'View configuration':'Compare / restore',()=>{
          const text=el('div',{},el('p',{text:`Selected revision ${h.revision}; active revision ${active.revision}. Changes are highlighted by route below.`}));
          const all=new Set([...active.config.routes.map(r=>r.id),...h.config.routes.map(r=>r.id)]);
          const changes=[...all].map(id=>{
            const before=active.config.routes.find(r=>r.id===id), after=h.config.routes.find(r=>r.id===id);
            return !before?`Add ${id}`:!after?`Remove ${id}`:JSON.stringify(before)!==JSON.stringify(after)?`Change ${id}`:null;
          }).filter(Boolean);
          text.append(el('p',{text:changes.join(' · ')||'No route changes'}),el('h3',{text:'Current configuration'}),el('pre',{class:'demo-output',text:JSON.stringify(active.config,null,2)}),el('h3',{text:'Selected configuration'}),el('pre',{class:'demo-output',text:JSON.stringify(h.config,null,2)}));
          let saving=false;
          openModal({title:`Configuration revision ${h.revision}`,body:text,actions:[{label:'Close',kind:'ghost',onClick:close=>close()},...(!current?[{label:'Restore as new revision',kind:'primary',onClick:async close=>{
            if(saving)return;saving=true;
            try {await putConfig(h.config,active.revision);close();toast('Configuration restored as a new revision','success');await store.refreshConfig();await refresh();}
            catch(e){toast(e.conflict?'Configuration changed. Close this preview and refresh history before restoring.':e.message,'error');}
            finally{saving=false;}
          }}]:[])]});
        });
        return el('div',{class:`demo-history-row${current?' is-active':''}`},
          el('div',{class:'demo-history-info'},el('strong',{text:`Revision ${h.revision}`}),el('span',{class:'demo-note',text:`${h.config.routes.length} routes`})),
          current?el('span',{class:'demo-status demo-status-2',text:'Active'}):null,view);
      }));
    }catch(e){summary.textContent=`History unavailable: ${e.message}`;}
    finally{busy=false;}
  };
  panel('config-history').append(el('div',{class:'demo-toolbar'},button('Refresh history',refresh)),summary,list);
  store.subscribe(({type,state})=>{if(type==='config' && state.configRevision!==revision)refresh();});
  refresh();
}
