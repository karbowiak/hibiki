import { create } from "zustand"
import type { OfflineContext } from "../../offline/nativeCache"
import type { MusicProvider } from "../../providers/types"
import type { LibrarySection, PlexAuthPin, PlexSettings } from "./types"
import type { PlexConnectionInfo } from "./api"

export class ConnectionSupersededError extends Error {
  constructor() {
    super("Plex connection was superseded")
  }
}

interface ConnectionContext {
  revision: number
  baseUrl: string
  token: string
  allUrls: string[]
  machineIdentifier: string
  sections: LibrarySection[]
  cacheScopes: Record<string, string>
}

export interface ConnectionDependencies {
  loadSettings(): Promise<PlexSettings>
  connectPlex(
    baseUrl: string,
    token: string,
    revision: number,
    acceptInvalidCerts?: boolean,
    expectedMachineIdentifier?: string
  ): Promise<PlexConnectionInfo>
  disconnectPlex(clearSaved: boolean): Promise<number>
  saveSettings(
    revision: number,
    allUrls: string[],
    sectionId?: number,
    sectionUuid?: string
  ): Promise<void>
  testServerConnection(
    url: string,
    expectedMachineIdentifier?: string
  ): Promise<number>
  startPlexAuth(): Promise<PlexAuthPin>
  createProvider(
    context: ConnectionContext,
    section: LibrarySection
  ): Promise<MusicProvider>
  activateProvider(
    provider: MusicProvider,
    context: ConnectionContext,
    section: LibrarySection,
    ownsRequest: () => boolean
  ): void | Promise<void>
  restoreOfflineContext?(revision: number): Promise<OfflineContext>
  activateOfflineProvider?(
    context: OfflineContext,
    ownsRequest: () => boolean
  ): Promise<void>
  clearSession(): void
}

export interface ConnectionState {
  baseUrl: string
  token: string
  isConnected: boolean
  isOffline: boolean
  isLoading: boolean
  error: string | null
  musicSectionId: number | null
  sectionUuid: string | null
  musicSectionTitle: string | null
  allUrls: string[]
  tlsExceptions: string[]
  availableMusicSections: LibrarySection[]
  needsLibraryPick: boolean
  loadAndConnect(): Promise<void>
  browseSavedLibrary(): Promise<void>
  connect(
    baseUrl: string,
    token: string,
    allUrls?: string[],
    savedSectionId?: number,
    acceptInvalidCerts?: boolean,
    expectedMachineIdentifier?: string
  ): Promise<void>
  selectLibrary(section: LibrarySection): Promise<void>
  switchLibrary(section: LibrarySection): Promise<void>
  disconnect(): void
  disconnectAndClear(): Promise<void>
  clearError(): void
  startPlexAuth(): Promise<PlexAuthPin>
}

/** Each operation owns its UI writes; native revisions also fence IPC and disk writes. */
export function createPlexConnectionStore(deps: ConnectionDependencies) {
  let generation = 0
  let context: ConnectionContext | null = null
  let resets: Promise<unknown> = Promise.resolve()
  let saves: Promise<unknown> = Promise.resolve()
  const current = (request: number) => request === generation
  const check = (request: number) => {
    if (!current(request)) throw new ConnectionSupersededError()
  }
  const blank = {
    baseUrl: "",
    token: "",
    musicSectionId: null,
    sectionUuid: null,
    musicSectionTitle: null,
    allUrls: [],
    tlsExceptions: [],
    availableMusicSections: [],
    needsLibraryPick: false,
    isConnected: false,
    isOffline: false,
    error: null,
  }

  return create<ConnectionState>((set) => {
    function begin(clearConnection = true) {
      const request = ++generation
      deps.clearSession()
      if (clearConnection) context = null
      set({
        ...(clearConnection ? blank : {}),
        isConnected: false,
        isOffline: false,
        needsLibraryPick: false,
        isLoading: true,
        error: null,
      })
      return request
    }

    // Only short native revocations are serialized; server I/O remains cancellable.
    function reset(request: number, clearSaved: boolean) {
      const operation = resets.then(async () => {
        check(request)
        const revision = await deps.disconnectPlex(clearSaved)
        check(request)
        return revision
      })
      resets = operation.catch(() => {})
      return operation
    }

    function save(
      request: number,
      connection: ConnectionContext,
      section?: LibrarySection
    ) {
      const operation = saves.then(async () => {
        check(request)
        await deps.saveSettings(
          connection.revision,
          connection.allUrls,
          section?.key,
          section?.uuid ?? undefined
        )
        check(request)
      })
      saves = operation.catch(() => {})
      return operation
    }

    async function chooseLibrary(
      request: number,
      connection: ConnectionContext,
      section: LibrarySection
    ) {
      check(request)
      await save(request, connection, section)
      const provider = await deps.createProvider(connection, section)
      if (!current(request)) {
        await provider.disconnect()
        throw new ConnectionSupersededError()
      }
      await deps.activateProvider(provider, connection, section, () =>
        current(request)
      )
      if (!current(request)) {
        await provider.disconnect()
        throw new ConnectionSupersededError()
      }
      set({
        isConnected: true,
        isLoading: false,
        musicSectionId: section.key,
        sectionUuid: section.uuid ?? null,
        musicSectionTitle: section.title,
        needsLibraryPick: false,
      })
    }

    async function establish(
      request: number,
      revision: number,
      baseUrl: string,
      token: string,
      allUrls?: string[],
      savedSectionId?: number,
      acceptInvalidCerts?: boolean,
      expectedMachineIdentifier?: string
    ) {
      check(request)
      const info = await deps.connectPlex(
        baseUrl,
        token,
        revision,
        acceptInvalidCerts,
        expectedMachineIdentifier
      )
      check(request)
      const sections = info.sections.filter(
        (section) => section.section_type === "artist"
      )
      if (!sections.length)
        throw new Error("No music libraries found on this server.")
      const connection = {
        revision,
        baseUrl,
        token,
        allUrls: [...new Set([baseUrl, ...(allUrls ?? [])])],
        machineIdentifier: info.machineIdentifier,
        cacheScopes: info.cacheScopes ?? {},
        sections,
      }
      await save(request, connection)
      const saved = await deps.loadSettings()
      check(request)
      context = connection
      set({
        baseUrl,
        token,
        allUrls: connection.allUrls,
        tlsExceptions: saved.tls_exceptions ?? [],
        availableMusicSections: sections,
      })
      const section =
        sections.length === 1
          ? sections[0]
          : sections.find((section) => section.key === savedSectionId)
      if (section) await chooseLibrary(request, connection, section)
      else set({ isLoading: false, needsLibraryPick: true })
    }

    async function failed(request: number, error: unknown) {
      if (!current(request)) return
      context = null
      deps.clearSession()
      // Authentication may have succeeded before a later persistence/provider failure.
      try {
        await reset(request, false)
      } catch {
        /* Preserve the original error. */
      }
      if (current(request))
        set({ ...blank, isLoading: false, error: String(error) })
    }

    async function select(section: LibrarySection) {
      const connection = context
      const selected = connection?.sections.find(
        (candidate) =>
          candidate.key === section.key && candidate.uuid === section.uuid
      )
      if (!connection || !selected)
        throw new Error("Select a music library from the connected server.")
      const request = begin(false)
      try {
        await chooseLibrary(request, connection, selected)
      } catch (error) {
        await failed(request, error)
        throw error
      }
    }

    return {
      ...blank,
      isLoading: true,
      browseSavedLibrary: async () => {
        const request = begin()
        try {
          const revision = await reset(request, false)
          if (!deps.restoreOfflineContext || !deps.activateOfflineProvider)
            throw new Error("Saved library browsing is unavailable.")
          const saved = await deps.restoreOfflineContext(revision)
          check(request)
          if (
            saved.revision !== revision ||
            !/^plex-[a-f0-9]{64}$/.test(saved.cacheScope) ||
            !Number.isSafeInteger(saved.sectionId) ||
            saved.sectionId <= 0
          )
            throw new Error("Saved library identity is unavailable.")
          await deps.activateOfflineProvider(saved, () => current(request))
          check(request)
          set({
            isConnected: false,
            isOffline: true,
            isLoading: false,
            error: null,
            musicSectionId: saved.sectionId,
            sectionUuid: saved.sectionUuid,
            musicSectionTitle: saved.sectionTitle,
            baseUrl: saved.baseUrl,
            token: "",
          })
        } catch {
          await failed(
            request,
            new Error(
              "This saved library is unavailable. Connect to Plex and visit some library pages before browsing offline."
            )
          )
        }
      },
      loadAndConnect: async () => {
        const request = begin()
        try {
          const revision = await reset(request, false)
          const settings = await deps.loadSettings()
          check(request)
          set({ tlsExceptions: settings.tls_exceptions ?? [] })
          if (!settings.base_url || !settings.token) {
            set({ isLoading: false })
            return
          }
          const urls = settings.all_urls ?? []
          const expected = settings.machine_identifier || undefined
          try {
            await establish(
              request,
              revision,
              settings.base_url,
              settings.token,
              urls,
              settings.section_id || undefined,
              undefined,
              expected
            )
            return
          } catch (error) {
            check(request)
            const fallbacks = [...new Set(urls)].filter(
              (url) => url !== settings.base_url
            )
            // Older saved settings have no verified identity; refresh via sign-in rather
            // than exposing their token to an address that now belongs to another server.
            if (!fallbacks.length) throw error
            if (!expected)
              throw new Error(
                "The saved Plex server has no verified identity. Sign in with Plex again to refresh its connection URLs."
              )
            const probes = await Promise.allSettled(
              fallbacks.map(async (url) => ({
                url,
                latency: await deps.testServerConnection(url, expected),
              }))
            )
            check(request)
            const reachable = probes
              .filter(
                (
                  probe
                ): probe is PromiseFulfilledResult<{
                  url: string
                  latency: number
                }> => probe.status === "fulfilled"
              )
              .map((probe) => probe.value)
              .sort(
                (a, b) =>
                  Number(b.url.startsWith("https://")) -
                    Number(a.url.startsWith("https://")) ||
                  a.latency - b.latency
              )
            for (const candidate of reachable) {
              try {
                await establish(
                  request,
                  revision,
                  candidate.url,
                  settings.token,
                  urls,
                  settings.section_id || undefined,
                  undefined,
                  expected
                )
                return
              } catch {
                check(request)
              }
            }
            throw new Error(
              "Could not reach the saved Plex server. Sign in with Plex again to refresh its connection URLs."
            )
          }
        } catch (error) {
          await failed(request, error)
          if(!current(request) || !deps.restoreOfflineContext || !deps.activateOfflineProvider)return
          try {
            const revision=await reset(request,false)
            const saved=await deps.restoreOfflineContext(revision)
            check(request)
            if(saved.revision!==revision || !/^plex-[a-f0-9]{64}$/.test(saved.cacheScope) || !Number.isSafeInteger(saved.sectionId) || saved.sectionId<=0)throw new Error("Saved library identity is unavailable.")
            await deps.activateOfflineProvider(saved,()=>current(request));check(request)
            set({isConnected:false,isOffline:true,isLoading:false,error:null,musicSectionId:saved.sectionId,sectionUuid:saved.sectionUuid,musicSectionTitle:saved.sectionTitle,baseUrl:saved.baseUrl,token:""})
          }catch{/* Keep the connection error when no trusted local catalogue exists. */}
        }
      },
      connect: async (
        baseUrl,
        token,
        allUrls,
        savedSectionId,
        acceptInvalidCerts,
        expectedMachineIdentifier
      ) => {
        const request = begin()
        try {
          const revision = await reset(request, false)
          await establish(
            request,
            revision,
            baseUrl,
            token,
            allUrls,
            savedSectionId,
            acceptInvalidCerts,
            expectedMachineIdentifier
          )
        } catch (error) {
          await failed(request, error)
          throw error
        }
      },
      selectLibrary: select,
      switchLibrary: select,
      disconnect: () => {
        const request = begin()
        set({ isLoading: false })
        void reset(request, false).catch((error) => {
          if (current(request)) set({ error: String(error) })
        })
      },
      disconnectAndClear: async () => {
        const request = begin()
        try {
          await reset(request, true)
          if (current(request)) set({ isLoading: false })
        } catch (error) {
          if (current(request)) set({ isLoading: false, error: String(error) })
          throw error
        }
      },
      clearError: () => set({ error: null }),
      startPlexAuth: async () => {
        set({ error: null })
        return deps.startPlexAuth()
      },
    }
  })
}
