import{t as e}from"./index-DGfbQdoc.js";import{c as t,n,t as r}from"./demo-data-source-B52CUuKx.js";var i=e(),a=[{id:`product-1`,name:`Amber poster`,quantity:12,status:`ready`,active:!0},{id:`product-2`,name:`Blue card`,quantity:24,status:`draft`,active:!1},{id:`product-3`,name:`Cedar label`,quantity:36,status:`ready`,active:!0}],o=t(),{dataSource:s}=r({name:`quick-start`,initialRows:a,columns:[o.field(`name`,{label:`Name`,type:`string`,sortable:!0}),o.field(`quantity`,{label:`Quantity`,type:`number`,typeOptions:{minimum:0}}),o.field(`status`,{label:`Status`,type:`singleSelect`,options:[{value:`draft`,label:`Draft`},{value:`ready`,label:`Ready`}]}),o.field(`active`,{label:`Active`,type:`boolean`})],persistence:{mode:`auto-save`,debounceMs:250}}),c=`const column = createGridColumnHelper<Product>()
const columns = [
  column.field('name', { label: 'Name', type: 'string' }),
  column.field('active', { label: 'Active', type: 'boolean' }),
]

const dataSource = createRemoteGridDataSource({
  columns,
  getRowKey: row => row.id,
  model: createFieldGridDocumentModel(columns),
  scope: productsApi.scope,
  source: productsApi.persistenceSource,
  persistence: { mode: 'auto-save' },
})

<DataGrid ariaLabel="Products" dataSource={dataSource} />`;function l(){return(0,i.jsxs)(`main`,{className:`quick-start-page`,children:[(0,i.jsxs)(`header`,{className:`quick-start-header`,children:[(0,i.jsxs)(`div`,{children:[(0,i.jsx)(`p`,{className:`demo-eyebrow`,children:`Quick start`}),(0,i.jsx)(`h1`,{children:`Minimal API-backed grid`})]}),(0,i.jsxs)(`div`,{"aria-label":`Example features`,className:`quick-start-features`,children:[(0,i.jsx)(`span`,{children:`Default cell types`}),(0,i.jsx)(`span`,{children:`Auto-save`}),(0,i.jsx)(`span`,{children:`No registry setup`})]})]}),(0,i.jsxs)(`section`,{className:`quick-start-workspace`,children:[(0,i.jsx)(`div`,{className:`quick-start-grid-panel`,children:(0,i.jsx)(n,{ariaLabel:`Quick-start products`,dataSource:s})}),(0,i.jsxs)(`section`,{"aria-labelledby":`quick-start-code-heading`,className:`quick-start-code-panel`,children:[(0,i.jsxs)(`div`,{children:[(0,i.jsx)(`h2`,{id:`quick-start-code-heading`,children:`Complete integration`}),(0,i.jsx)(`a`,{href:`https://www.npmjs.com/package/data-editor-table`,children:`npm`})]}),(0,i.jsx)(`pre`,{"data-testid":`quick-start-code`,children:(0,i.jsx)(`code`,{children:c})})]})]})]})}export{l as QuickStartPage};