import{t as e}from"./index-B7K2bhmu.js";import{d as t,f as n,p as r,t as i}from"./data-grid-C3pPqp1-.js";import{t as a}from"./column-helper-C1kpYbUH.js";function o(e){let t=new Set,n=new Set,i=c(e.initialSnapshot),a=0,o=Promise.resolve(),u=0,d=0,f=0,p=null;l(i,e.getRowKey);let m=t=>{let n=c(t);l(n,e.getRowKey);let a=Object.is(i.version,n.version);if(a&&!r(i.rows,n.rows,e.getRowKey))throw Error(`A remote data source cannot reuse one version for different authoritative rows.`);return Object.freeze({normalized:n,sameVersion:a})},h=(e,n)=>{i=e.normalized;let{sameVersion:r}=e;(n===!0||n===`when-changed`&&!r)&&(u+=1);for(let e of t)try{e()}catch{}},g=(e,t)=>{h(m(e),t)},_=e=>{let t=m(e);f+=1,p=null,h(t,`when-changed`)},v=e=>a===0||e.aborted?Promise.resolve():new Promise(t=>{let r=()=>{e.removeEventListener(`abort`,r),n.delete(r),t()};n.add(r),e.addEventListener(`abort`,r,{once:!0})}),y=()=>{if(--a,a===0){for(let e of n)e();n.clear()}},b=async(t,n,r)=>{if(!e.load)throw Error(t===`refresh`?`This remote data source does not define an authority loader.`:`This mutation requires an authority reload, but no loader is configured.`);let a=await e.load({reason:t,current:i,signal:n,...r===void 0?{}:{operationId:r}});if(n.aborted)throw n.reason;return s(a)},x={columns:e.columns,getRowKey:e.getRowKey,getSnapshot:()=>i,subscribe(e){return t.add(e),()=>{t.delete(e)}},publish:_,...e.cloneRow?{cloneRow:e.cloneRow}:{},...e.rows?{rows:e.rows}:{},...e.load?{async refresh({signal:e}){for(;a>0;)if(await v(e),e.aborted)return;if(e.aborted)return;let t=p?.before??i,n=++f,r=u,o=d;p=Object.freeze({id:n,before:t,startingAuthorityRevision:r});let s=()=>n===f&&u===r&&d===o;g(Object.freeze({rows:t.rows,version:t.version,scope:t.scope,status:t.status===`loading`?`loading`:`refreshing`}),!1);try{let t=await b(`refresh`,e);if(!s())return;p=null,g(t,!0)}catch(n){if(!s())return;if(p=null,e.aborted){g(t,!1);return}throw g(Object.freeze({rows:i.rows,version:i.version,scope:i.scope,status:`error`,error:n instanceof Error?n.message:String(n)}),!0),n}}}:{},persistence:{mode:e.persistence.mode,...e.persistence.debounceMs===void 0?{}:{debounceMs:e.persistence.debounceMs},async commit(t){let n=p;f+=1,p=null,n&&u===n.startingAuthorityRevision&&g(n.before,!1),d+=1;let r=a>0;a+=1;let i=async()=>{let n=u,r=await e.persistence.mutate(t),i=r.kind===`applied`?s(r.authority):await b(`after-mutation`,new AbortController().signal,t.operationId);return u===n&&g(i,!0),Object.freeze({operationId:t.operationId,applied:i,...r.keyRemap===void 0?{}:{keyRemap:Object.freeze([...r.keyRemap])}})},c=r?o.then(i):i();o=c.then(()=>void 0,()=>void 0);try{return await c}finally{y()}}}};return Object.freeze(x)}function s(e){return Object.freeze({rows:Object.freeze([...e.rows]),version:e.version,scope:Object.freeze({kind:`complete`}),status:`ready`})}function c(e){let t={rows:Object.freeze([...e.rows]),version:e.version,scope:Object.freeze({kind:`complete`})};return e.status===`error`?Object.freeze({...t,status:`error`,error:e.error}):Object.freeze({...t,status:e.status})}function l(e,r){t(e),n(e,r)}var u=e(),d=[{id:`product-1`,name:`Amber poster`,quantity:12,status:`ready`,active:!0},{id:`product-2`,name:`Blue card`,quantity:24,status:`draft`,active:!1},{id:`product-3`,name:`Cedar label`,quantity:36,status:`ready`,active:!0}],f=a(),p=o({columns:[f.field(`name`,{label:`Name`,type:`string`,sortable:!0}),f.field(`quantity`,{label:`Quantity`,type:`number`,typeOptions:{minimum:0}}),f.field(`status`,{label:`Status`,type:`singleSelect`,options:[{value:`draft`,label:`Draft`},{value:`ready`,label:`Ready`}]}),f.field(`active`,{label:`Active`,type:`boolean`})],getRowKey:e=>e.id,initialSnapshot:{rows:d,status:`ready`,version:1,scope:{kind:`complete`}},persistence:{mode:`auto-save`,debounceMs:250,mutate:h}}),m={rows:d,version:1};async function h(e){return m={rows:Object.freeze([...e.rows]),version:m.version+1},{kind:`applied`,authority:m}}var g=`import {
  DataGrid,
  createGridColumnHelper,
  createRemoteGridDataSource,
} from 'data-editor-table'
import 'data-editor-table/styles.css'

type Product = {
  id: string
  name: string
  active: boolean
}

const column = createGridColumnHelper<Product>()

const dataSource = createRemoteGridDataSource({
  columns: [
    column.field('name', { label: 'Name', type: 'string' }),
    column.field('active', { label: 'Active', type: 'boolean' }),
  ],
  getRowKey: (row) => row.id,
  initialSnapshot: bootstrapProducts,
  persistence: {
    mode: 'auto-save',
    mutate: (request) => productsApi.applyGridChanges(request),
  },
})

export function ProductEditor() {
  return <DataGrid ariaLabel="Products" dataSource={dataSource} />
}`;function _(){return(0,u.jsxs)(`main`,{className:`quick-start-page`,children:[(0,u.jsxs)(`header`,{className:`quick-start-header`,children:[(0,u.jsxs)(`div`,{children:[(0,u.jsx)(`p`,{className:`demo-eyebrow`,children:`Quick start`}),(0,u.jsx)(`h1`,{children:`Minimal API-backed grid`})]}),(0,u.jsxs)(`div`,{"aria-label":`Example features`,className:`quick-start-features`,children:[(0,u.jsx)(`span`,{children:`Default cell types`}),(0,u.jsx)(`span`,{children:`Auto-save`}),(0,u.jsx)(`span`,{children:`No registry setup`})]})]}),(0,u.jsxs)(`section`,{className:`quick-start-workspace`,children:[(0,u.jsx)(`div`,{className:`quick-start-grid-panel`,children:(0,u.jsx)(i,{ariaLabel:`Quick-start products`,dataSource:p})}),(0,u.jsxs)(`section`,{"aria-labelledby":`quick-start-code-heading`,className:`quick-start-code-panel`,children:[(0,u.jsxs)(`div`,{children:[(0,u.jsx)(`h2`,{id:`quick-start-code-heading`,children:`Complete integration`}),(0,u.jsx)(`a`,{href:`https://www.npmjs.com/package/data-editor-table`,children:`npm`})]}),(0,u.jsx)(`pre`,{"data-testid":`quick-start-code`,children:(0,u.jsx)(`code`,{children:g})})]})]})]})}export{_ as QuickStartPage};