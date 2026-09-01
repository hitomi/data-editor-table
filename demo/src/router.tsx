import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createHashHistory,
  createRouter,
  lazyRouteComponent,
} from '@tanstack/react-router'

const rootRoute = createRootRoute({ component: DemoLayout })

const playgroundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: lazyRouteComponent(() => import('./playground'), 'PlaygroundPage'),
})

const multiImageImportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/multi-image-import',
  component: lazyRouteComponent(() => import('./multi-image-import'), 'MultiImageImportPage'),
})

const crossGridDragRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/cross-grid-drag',
  component: lazyRouteComponent(() => import('./cross-grid-drag'), 'CrossGridDragPage'),
})

const routeTree = rootRoute.addChildren([
  playgroundRoute,
  multiImageImportRoute,
  crossGridDragRoute,
])

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

function DemoLayout() {
  return (
    <div className="demo-app-shell">
      <nav aria-label="Demo pages" className="demo-nav">
        <Link activeOptions={{ exact: true }} activeProps={{ 'aria-current': 'page' }} to="/">
          Playground
        </Link>
        <Link activeProps={{ 'aria-current': 'page' }} to="/multi-image-import">
          Multi-image import
        </Link>
        <Link activeProps={{ 'aria-current': 'page' }} to="/cross-grid-drag">
          Cross-grid drag
        </Link>
      </nav>
      <div className="demo-route-stage">
        <Outlet />
      </div>
    </div>
  )
}
