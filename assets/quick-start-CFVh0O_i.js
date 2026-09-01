import{t as e}from"./index-CklrUS4B.js";import{f as t,p as n,t as r,u as i}from"./data-grid-CnBCiZ7-.js";import{t as a}from"./column-helper-C1kpYbUH.js";function o(e){let t=new Set,n=c(e.initialSnapshot),r=0;l(n,e.getRowKey);let a=a=>{let o=c(a);if(l(o,e.getRowKey),Object.is(n.version,o.version)&&!i(n.rows,o.rows,e.getRowKey))throw Error(`A remote data source cannot reuse one version for different authoritative rows.`);n=o,r+=1;for(let e of t)try{e()}catch{}},o=async(t,r,i)=>{if(!e.load)throw Error(t===`refresh`?`This remote data source does not define an authority loader.`:`This mutation requires an authority reload, but no loader is configured.`);let a=await e.load({reason:t,current:n,signal:r,...i===void 0?{}:{operationId:i}});if(r.aborted)throw r.reason;return s(a)},u={columns:e.columns,getRowKey:e.getRowKey,getSnapshot:()=>n,subscribe(e){return t.add(e),()=>{t.delete(e)}},publish:a,...e.cloneRow?{cloneRow:e.cloneRow}:{},...e.rows?{rows:e.rows}:{},...e.load?{async refresh({signal:e}){let t=n;a(Object.freeze({rows:t.rows,version:t.version,scope:t.scope,status:t.status===`loading`?`loading`:`refreshing`}));let i=r;try{a(await o(`refresh`,e))}catch(t){if(e.aborted||r!==i)return;throw a(Object.freeze({rows:n.rows,version:n.version,scope:n.scope,status:`error`,error:t instanceof Error?t.message:String(t)})),t}}}:{},persistence:{mode:e.persistence.mode,...e.persistence.debounceMs===void 0?{}:{debounceMs:e.persistence.debounceMs},async commit(t){let n=await e.persistence.mutate(t),r=n.kind===`applied`?s(n.authority):await o(`after-mutation`,new AbortController().signal,t.operationId);return a(r),Object.freeze({operationId:t.operationId,applied:r,...n.keyRemap===void 0?{}:{keyRemap:Object.freeze([...n.keyRemap])}})}}};return Object.freeze(u)}function s(e){return Object.freeze({rows:Object.freeze([...e.rows]),version:e.version,scope:Object.freeze({kind:`complete`}),status:`ready`})}function c(e){let t={rows:Object.freeze([...e.rows]),version:e.version,scope:Object.freeze({kind:`complete`})};return e.status===`error`?Object.freeze({...t,status:`error`,error:e.error}):Object.freeze({...t,status:e.status})}function l(e,r){t(e),n(e,r)}var u=e(),d=[{id:`product-1`,name:`Amber poster`,quantity:12,status:`ready`,active:!0},{id:`product-2`,name:`Blue card`,quantity:24,status:`draft`,active:!1},{id:`product-3`,name:`Cedar label`,quantity:36,status:`ready`,active:!0}],f=a(),p=o({columns:[f.field(`name`,{label:`Name`,type:`string`,sortable:!0}),f.field(`quantity`,{label:`Quantity`,type:`number`,typeOptions:{minimum:0}}),f.field(`status`,{label:`Status`,type:`singleSelect`,options:[{value:`draft`,label:`Draft`},{value:`ready`,label:`Ready`}]}),f.field(`active`,{label:`Active`,type:`boolean`})],getRowKey:e=>e.id,initialSnapshot:{rows:d,status:`ready`,version:1,scope:{kind:`complete`}},persistence:{mode:`auto-save`,debounceMs:250,mutate:h}}),m={rows:d,version:1};async function h(e){return m={rows:Object.freeze([...e.rows]),version:m.version+1},{kind:`applied`,authority:m}}var g=`import {
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
}`;function _(){return(0,u.jsxs)(`main`,{className:`quick-start-page`,children:[(0,u.jsxs)(`header`,{className:`quick-start-header`,children:[(0,u.jsxs)(`div`,{children:[(0,u.jsx)(`p`,{className:`demo-eyebrow`,children:`Quick start`}),(0,u.jsx)(`h1`,{children:`Minimal API-backed grid`})]}),(0,u.jsxs)(`div`,{"aria-label":`Example features`,className:`quick-start-features`,children:[(0,u.jsx)(`span`,{children:`Default cell types`}),(0,u.jsx)(`span`,{children:`Auto-save`}),(0,u.jsx)(`span`,{children:`No registry setup`})]})]}),(0,u.jsxs)(`section`,{className:`quick-start-workspace`,children:[(0,u.jsx)(`div`,{className:`quick-start-grid-panel`,children:(0,u.jsx)(r,{ariaLabel:`Quick-start products`,dataSource:p})}),(0,u.jsxs)(`section`,{"aria-labelledby":`quick-start-code-heading`,className:`quick-start-code-panel`,children:[(0,u.jsxs)(`div`,{children:[(0,u.jsx)(`h2`,{id:`quick-start-code-heading`,children:`Complete integration`}),(0,u.jsx)(`a`,{href:`https://www.npmjs.com/package/data-editor-table`,children:`npm`})]}),(0,u.jsx)(`pre`,{"data-testid":`quick-start-code`,children:(0,u.jsx)(`code`,{children:g})})]})]})]})}export{_ as QuickStartPage};