export type DemoRow = {
  id: string
  image: string | null
  name: string
  quantity: number
  deliveryDate: string
  status: 'draft' | 'ready' | 'archived'
  tags: readonly ('featured' | 'seasonal' | 'wholesale' | 'legacy')[]
  active: boolean
}

export const initialRows: readonly DemoRow[] = [
  { id: 'row-1', image: null, name: 'Amber poster', quantity: 12, deliveryDate: '2026-09-02', status: 'ready', tags: ['featured', 'seasonal', 'wholesale'], active: true },
  { id: 'row-2', image: null, name: 'Blue card', quantity: 14, deliveryDate: '2026-09-05', status: 'draft', tags: ['wholesale'], active: false },
  { id: 'row-3', image: null, name: 'Cedar label', quantity: 16, deliveryDate: '2026-09-08', status: 'archived', tags: ['legacy'], active: false },
  { id: 'row-4', image: null, name: 'Dune notebook', quantity: 18, deliveryDate: '2026-09-12', status: 'ready', tags: ['featured'], active: true },
  { id: 'row-5', image: null, name: 'Ember envelope', quantity: 20, deliveryDate: '2026-09-16', status: 'draft', tags: [], active: true },
  { id: 'row-6', image: null, name: 'Fern calendar', quantity: 22, deliveryDate: '2026-09-21', status: 'ready', tags: ['seasonal'], active: true },
  ...[
    'Granite folio', 'Harbor postcard', 'Indigo planner', 'Juniper tag', 'Kite memo pad',
    'Linen folder', 'Moss invitation', 'Navy bookmark', 'Ochre sketchbook', 'Pine notecard',
    'Quartz print', 'Reed journal', 'Sienna sticker', 'Tide envelope', 'Umber catalogue',
    'Vale gift card', 'Willow checklist', 'Xenia place card', 'Yarrow receipt', 'Zinc sleeve',
    'Alpine ticket', 'Birch sign', 'Clay swatch', 'Drift brochure', 'Elm index card',
    'Flint label', 'Grove workbook', 'Haze menu', 'Iris voucher', 'Jade booklet',
  ].map((name, index): DemoRow => ({
    id: `row-${index + 7}`,
    image: null,
    name,
    quantity: 24 + index * 2,
    deliveryDate: `2026-10-${String(index % 28 + 1).padStart(2, '0')}`,
    status: index % 3 === 0 ? 'draft' : 'ready',
    tags: index % 4 === 0 ? ['featured', 'wholesale'] : index % 3 === 0 ? ['seasonal'] : [],
    active: index % 5 !== 0,
  })),
]
