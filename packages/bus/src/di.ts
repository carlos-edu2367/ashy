export class CircularDependencyError extends Error {
  public readonly cyclePath: readonly string[]

  constructor(cyclePath: string[]) {
    super(`Circular dependency detected in DI container: ${cyclePath.join(' -> ')}`)
    this.name = 'CircularDependencyError'
    this.cyclePath = Object.freeze([...cyclePath])
  }
}

export interface LifecycleRegistrar<T = unknown> {
  onStart(hook: (instance: T) => void | Promise<void>): void
  onStop(hook: (instance: T) => void | Promise<void>): void
}

export type DependencyMap = Record<string, ProviderToken<any, any>>

export type ResolvedDependencies<TDeps extends DependencyMap> = {
  [K in keyof TDeps]: TDeps[K] extends ProviderToken<infer TVal, any> ? TVal : never
}

export type BuildContext<TDeps extends DependencyMap> = ResolvedDependencies<TDeps> & {
  dependsOn: ResolvedDependencies<TDeps>
  lifecycle: LifecycleRegistrar<any>
}

export interface ProviderOptions<T, TDeps extends DependencyMap = {}> {
  name?: string
  dependsOn?: TDeps
  build: (ctx: BuildContext<TDeps>) => T | Promise<T>
  onStart?: (instance: T, ctx: BuildContext<TDeps>) => void | Promise<void>
  onStop?: (instance: T, ctx: BuildContext<TDeps>) => void | Promise<void>
}

export interface ProviderToken<T, TDeps extends DependencyMap = {}> {
  readonly id: symbol
  readonly name: string
  readonly dependsOn: TDeps
  readonly build: (ctx: BuildContext<TDeps>) => T | Promise<T>
  readonly onStart?: (instance: T, ctx: BuildContext<TDeps>) => void | Promise<void>
  readonly onStop?: (instance: T, ctx: BuildContext<TDeps>) => void | Promise<void>
}

export interface InvokeOptions<TDeps extends DependencyMap = {}> {
  name?: string
  dependsOn?: TDeps
  callback?: (ctx: BuildContext<TDeps>) => unknown | Promise<unknown>
  fn?: (ctx: BuildContext<TDeps>) => unknown | Promise<unknown>
  run?: (ctx: BuildContext<TDeps>) => unknown | Promise<unknown>
  build?: (ctx: BuildContext<TDeps>) => unknown | Promise<unknown>
}

export interface DIContainer {
  provide<T, TDeps extends DependencyMap = {}>(
    name: string,
    options: ProviderOptions<T, TDeps>,
  ): ProviderToken<T, TDeps>
  provide<T, TDeps extends DependencyMap = {}>(
    options: ProviderOptions<T, TDeps>,
  ): ProviderToken<T, TDeps>
  invoke<TDeps extends DependencyMap = {}>(
    name: string,
    options: InvokeOptions<TDeps>,
  ): void
  invoke<TDeps extends DependencyMap = {}>(options: InvokeOptions<TDeps>): void
  invoke(callback: () => unknown | Promise<unknown>): void
  resolve<T, TDeps extends DependencyMap = {}>(
    token: ProviderToken<T, TDeps>,
  ): Promise<T>
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * Performs topological sorting over provider tokens (leaves/dependencies first).
 * Throws `CircularDependencyError` if any cycle exists in the dependency graph.
 */
export function topologicalSort(roots: Iterable<ProviderToken<any, any>>): ProviderToken<any, any>[] {
  const state = new Map<symbol, 0 | 1 | 2>() // 0 = unvisited, 1 = visiting, 2 = visited
  const stack: ProviderToken<any, any>[] = []
  const sorted: ProviderToken<any, any>[] = []

  function visit(token: ProviderToken<any, any>): void {
    const currentState = state.get(token.id) ?? 0
    if (currentState === 2) {
      return
    }
    if (currentState === 1) {
      const cycleStartIdx = stack.findIndex((item) => item.id === token.id)
      const cycleNames = [
        ...stack.slice(cycleStartIdx >= 0 ? cycleStartIdx : 0).map((t) => t.name),
        token.name,
      ]
      throw new CircularDependencyError(cycleNames)
    }

    state.set(token.id, 1)
    stack.push(token)

    const deps = token.dependsOn ?? {}
    for (const depKey of Object.keys(deps)) {
      const depToken = deps[depKey]
      if (depToken && typeof depToken === 'object' && 'id' in depToken) {
        visit(depToken)
      }
    }

    stack.pop()
    state.set(token.id, 2)
    sorted.push(token)
  }

  for (const root of roots) {
    visit(root)
  }

  return sorted
}

export function createContainer(): DIContainer {
  const providers = new Map<symbol, ProviderToken<any, any>>()
  const instances = new Map<symbol, unknown>()
  const inFlight = new Map<symbol, Promise<unknown>>()
  const contexts = new Map<symbol, BuildContext<any>>()
  const dynamicStartHooks = new Map<symbol, Array<(instance: any) => void | Promise<void>>>()
  const dynamicStopHooks = new Map<symbol, Array<(instance: any) => void | Promise<void>>>()
  const startedIds = new Set<symbol>()
  let startedOrder: ProviderToken<any, any>[] = []

  interface RegisteredInvoke {
    name: string
    dependsOn: DependencyMap
    callback: (ctx: BuildContext<any>) => unknown | Promise<unknown>
  }
  const invokes: RegisteredInvoke[] = []

  function provide<T, TDeps extends DependencyMap = {}>(
    nameOrOptions: string | ProviderOptions<T, TDeps>,
    maybeOptions?: ProviderOptions<T, TDeps>,
  ): ProviderToken<T, TDeps> {
    const options =
      typeof nameOrOptions === 'string' ? maybeOptions! : nameOrOptions
    const name =
      typeof nameOrOptions === 'string'
        ? nameOrOptions
        : (options.name ?? `provider_${providers.size + 1}`)

    if (!options || typeof options.build !== 'function') {
      throw new TypeError(`Provider "${name}" must specify a build() function`)
    }

    const token: ProviderToken<T, TDeps> = {
      id: Symbol(name),
      name,
      dependsOn: (options.dependsOn ?? {}) as TDeps,
      build: options.build,
      onStart: options.onStart,
      onStop: options.onStop,
    }

    providers.set(token.id, token)
    return token
  }

  function invoke<TDeps extends DependencyMap = {}>(
    nameOrOptionsOrFn:
      | string
      | InvokeOptions<TDeps>
      | (() => unknown | Promise<unknown>),
    maybeOptions?: InvokeOptions<TDeps>,
  ): void {
    if (typeof nameOrOptionsOrFn === 'function') {
      invokes.push({
        name: `invoke_${invokes.length + 1}`,
        dependsOn: {},
        callback: nameOrOptionsOrFn,
      })
      return
    }

    const options =
      typeof nameOrOptionsOrFn === 'string' ? maybeOptions! : nameOrOptionsOrFn
    const name =
      typeof nameOrOptionsOrFn === 'string'
        ? nameOrOptionsOrFn
        : (options?.name ?? `invoke_${invokes.length + 1}`)

    const callback =
      options?.callback ?? options?.fn ?? options?.run ?? options?.build
    if (typeof callback !== 'function') {
      throw new TypeError(`Invoke "${name}" must provide a callback function`)
    }

    invokes.push({
      name,
      dependsOn: options.dependsOn ?? {},
      callback,
    })
  }

  async function buildDependencies<TDeps extends DependencyMap>(
    tokenId: symbol | null,
    deps: TDeps,
  ): Promise<BuildContext<TDeps>> {
    const entries = Object.entries(deps ?? {})
    const resolvedEntries = await Promise.all(
      entries.map(async ([key, depToken]) => {
        const val = await resolveInternal(depToken)
        return [key, val] as const
      }),
    )

    const resolvedMap = Object.fromEntries(resolvedEntries) as ResolvedDependencies<TDeps>
    const lifecycle: LifecycleRegistrar<any> = {
      onStart(hook) {
        if (!tokenId) return
        const list = dynamicStartHooks.get(tokenId) ?? []
        list.push(hook)
        dynamicStartHooks.set(tokenId, list)
      },
      onStop(hook) {
        if (!tokenId) return
        const list = dynamicStopHooks.get(tokenId) ?? []
        list.push(hook)
        dynamicStopHooks.set(tokenId, list)
      },
    }

    return {
      ...resolvedMap,
      dependsOn: resolvedMap,
      lifecycle,
    }
  }

  async function resolveInternal<T, TDeps extends DependencyMap = {}>(
    token: ProviderToken<T, TDeps>,
  ): Promise<T> {
    if (instances.has(token.id)) {
      return instances.get(token.id) as T
    }

    const existingPromise = inFlight.get(token.id)
    if (existingPromise) {
      return (await existingPromise) as T
    }

    // Ensure no circular dependency exists from this token before building
    topologicalSort([token])

    const buildPromise = (async () => {
      try {
        providers.set(token.id, token)
        dynamicStartHooks.set(token.id, [])
        dynamicStopHooks.set(token.id, [])

        const ctx = await buildDependencies(token.id, token.dependsOn)
        contexts.set(token.id, ctx)

        const instance = await token.build(ctx)
        instances.set(token.id, instance)
        return instance
      } catch (err) {
        inFlight.delete(token.id)
        throw err
      }
    })()

    inFlight.set(token.id, buildPromise)
    return await buildPromise
  }

  async function resolve<T, TDeps extends DependencyMap = {}>(
    token: ProviderToken<T, TDeps>,
  ): Promise<T> {
    if (!token || typeof token !== 'object' || !('id' in token)) {
      throw new TypeError('Invalid ProviderToken passed to container.resolve()')
    }
    return await resolveInternal(token)
  }

  async function start(): Promise<void> {
    const rootTokens = new Set<ProviderToken<any, any>>(providers.values())
    for (const inv of invokes) {
      for (const dep of Object.values(inv.dependsOn)) {
        rootTokens.add(dep)
      }
    }

    const sorted = topologicalSort(rootTokens)
    startedOrder = sorted

    for (const token of sorted) {
      const instance = await resolveInternal(token)
      if (!startedIds.has(token.id)) {
        const ctx = contexts.get(token.id)!
        if (typeof token.onStart === 'function') {
          await token.onStart(instance, ctx)
        }
        const extraHooks = dynamicStartHooks.get(token.id) ?? []
        for (const hook of extraHooks) {
          await hook(instance)
        }
        startedIds.add(token.id)
      }
    }

    for (const inv of invokes) {
      const ctx = await buildDependencies(null, inv.dependsOn)
      await inv.callback(ctx)
    }
  }

  async function stop(): Promise<void> {
    const reverseOrder = [...startedOrder].reverse()
    for (const token of reverseOrder) {
      if (!startedIds.has(token.id)) {
        continue
      }
      const instance = instances.get(token.id)
      const ctx = contexts.get(token.id)!

      const extraStopHooks = [...(dynamicStopHooks.get(token.id) ?? [])].reverse()
      for (const hook of extraStopHooks) {
        await hook(instance)
      }

      if (typeof token.onStop === 'function') {
        await token.onStop(instance, ctx)
      }

      startedIds.delete(token.id)
    }

    startedOrder = []
    instances.clear()
    inFlight.clear()
    contexts.clear()
    dynamicStartHooks.clear()
    dynamicStopHooks.clear()
  }

  return {
    provide,
    invoke,
    resolve,
    start,
    stop,
  }
}
