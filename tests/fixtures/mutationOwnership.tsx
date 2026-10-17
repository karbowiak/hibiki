import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { create } from "zustand"
import { deferred } from "../helpers/radioAudioFakes"
const scenario = process.argv[2]
const dom = new JSDOM("<div id='root'></div>", { url: "https://hibiki.test/playlist/same" })
Object.assign(globalThis, { window: dom.window, location: dom.window.location, history: dom.window.history, addEventListener: dom.window.addEventListener.bind(dom.window), removeEventListener: dom.window.removeEventListener.bind(dom.window), document: dom.window.document, localStorage: dom.window.localStorage, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
const writes: any[] = [], calls: any[] = [], loves: any[] = []
const localFavorites:any[]=[]
mock.module("../../src/stores/favoritesStore.ts",()=>({useFavoritesStore:create(()=>({loaded:false,likedTrackIds:new Set(),ratingChanged:async(...args:any[])=>{localFavorites.push(args)}}))}))
const library = create(() => ({ playlists: [{id:"same", title:"Original",smart:false}], error: null as string|null,
 invalidatePlaylistItems: (id:string)=>writes.push(["invalidate",id]), renamePlaylist:(id:string,title:string)=>writes.push(["rename",id,title]),removePlaylist:(id:string)=>writes.push(["delete",id]),onItemRated:(...args:any[])=>writes.push(["rate",...args]) }))
const player = create(()=>({playPlaylist(){},playTrack(){},playFromUri(){},playRadio(){},addNext:(tracks:any[])=>writes.push(["next",tracks]),addToQueue:(tracks:any[])=>writes.push(["queue",tracks])}))
mock.module("../../src/stores/index.ts",()=>({useLibraryStore:library,usePlayerStore:player}))
mock.module("../../src/stores/libraryStore.ts",()=>({useLibraryStore:library}))
mock.module("../../src/stores/playerStore.ts",()=>({usePlayerStore:player}))
mock.module("../../src/stores/uiStore.ts",()=>({useUIStore:create(()=>({isArtExpanded:false,setShowCreatePlaylist(){},setPendingPlaylistItemIds(){}}))}))
mock.module("../../src/stores/debugStore.ts",()=>({useDebugStore:create(()=>({debugEnabled:false}))}))
mock.module("../../src/stores/debugPanelStore.ts",()=>({useDebugPanelStore:create(()=>({show(){}}))}))
mock.module("../../src/metadata/deezer/store.ts",()=>({useDeezerMetadataStore:create(()=>({artists:{},albums:{}}))}))
mock.module("../../src/metadata/lastfm/authStore.ts",()=>({useLastfmStore:create(()=>({loveThreshold:8}))}))
mock.module("../../src/metadata/lastfm/api.ts",()=>({lastfmLoveTrack:async(...args:any[])=>{loves.push(args)}}))
mock.module("../../src/components/shared/ArtworkImage.tsx",()=>({ArtworkImage:()=>null}))
mock.module("../../src/hooks/useResizable.ts",()=>({useResizable:()=>({width:240,onMouseDown(){}})}))
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useContextMenuStore: menu } = await import("../../src/stores/contextMenuStore")
const first=deferred<any>(),second=deferred<any>()
function provider(name:string){return {cacheScope:name,capabilities:{playlists:true,playlistEdit:true,ratings:true,stations:false,radio:false},
 addToPlaylist:async(...args:any[])=>{calls.push(["add",name,...args]);return calls.filter(x=>x[0]==="add").length===1?first.promise:second.promise},
 editPlaylist:async(...args:any[])=>{calls.push(["rename",name,...args]);return first.promise},deletePlaylist:async(...args:any[])=>{calls.push(["delete",name,...args]);return first.promise},
 removeFromPlaylist:async(...args:any[])=>{calls.push(["remove",name,...args]);return first.promise},getAlbumTracks:async(...args:any[])=>{calls.push(["tracks",name,...args]);return first.promise},
 rate:async(...args:any[])=>{calls.push(["rate",name,...args]);return calls.filter(x=>x[0]==="rate").length===1?first.promise:second.promise} } as any}
const a=provider("a"),b=provider("b")
useProviderStore.getState().setProvider(a)
async function settle(){await act(async()=>{for(let i=0;i<8;i++)await Promise.resolve()})}
async function click(text:string){const button=[...document.querySelectorAll("button")].find(b=>b.textContent?.trim()===text);assert(button,`missing ${text}`);await act(async()=>button.click())}
async function replace(){await act(async()=>useProviderStore.getState().setProvider(b))}
async function resolve(value:any=undefined){first.resolve(value);await settle()}
async function unmount(){await act(async()=>root.unmount())}
if(scenario.startsWith("sidebar")){
 const {SideBar}=await import("../../src/components/SideBar")
 await act(async()=>root.render(<SideBar onCreatePlaylist={()=>{}}/>))
 await act(async()=>window.dispatchEvent(new dom.window.CustomEvent("plexify-media-drop",{detail:{targetPlaylistId:"same",payload:{type:"track",ids:["1","2","3"]}}})))
 assert.equal(calls.length,1)
 if(scenario==="sidebar-provider")await replace()
 if(scenario==="sidebar-unmount")await unmount()
 if(scenario==="sidebar-roundtrip")await act(async()=>{useProviderStore.getState().setProvider(b);useProviderStore.getState().setProvider(a)})
 await resolve()
 if(scenario==="sidebar-partial-failure"){
  assert.equal(calls.length,2);second.reject(Error("synthetic secret detail"));await settle();assert.deepEqual(writes,[["invalidate","same"]]);assert.equal(library.getState().error,"Unable to add items to the playlist. Please try again.")
 }else{assert.equal(calls.length,1);assert.deepEqual(writes,[]);assert.equal(library.getState().error,null)}
 if(scenario!=="sidebar-unmount")await unmount()
}else if(scenario.startsWith("rating")){
 const {StarRating}=await import("../../src/components/shared/StarRating")
 let closes=0;const render=(id="same")=><StarRating itemId={id} itemType={scenario==="rating-album-success"?"album":"track"} userRating={null} artist={scenario.includes("love")?"Artist":""} track={scenario.includes("love")?"Track":""} onRated={()=>closes++}/>
 await act(async()=>root.render(render()))
 const rate=async()=>{const button=document.querySelector('button[aria-label="4 stars"]') as HTMLButtonElement;assert(button);await act(async()=>button.click())}
 await rate();assert.equal(calls.length,1);assert.deepEqual(loves,[])
 if(scenario==="rating-provider")await replace()
 if(scenario==="rating-unmount")await unmount()
 if(scenario==="rating-row")await act(async()=>root.render(render("other")))
 if(scenario==="rating-failure" || scenario==="rating-love-failure"){first.reject(Error("synthetic secret"));await settle();assert.equal(closes,0);assert.equal(library.getState().error,null);assert(document.querySelector('[aria-description="Unable to save the rating. Please try again."]'));assert(!(document.querySelector('button[aria-label="4 stars"]') as HTMLButtonElement).disabled)}
 else if(scenario==="rating-success" || scenario==="rating-love-success" || scenario==="rating-album-success"){await rate();assert.equal(calls.length,1);await resolve();assert.deepEqual(writes,[["rate","same",scenario==="rating-album-success"?"album":"track",8]]);assert.equal(closes,1)}
 else if(scenario==="rating-capability"){await act(async()=>useProviderStore.getState().setProvider({...b,capabilities:{ratings:false}}));await resolve();assert.equal(document.querySelectorAll("button").length,0);assert.deepEqual(writes,[])}
 else{await resolve();assert.deepEqual(writes,[]);assert.equal(closes,0)}
 assert.deepEqual(loves,[])
 if(scenario==="rating-love-failure")assert.deepEqual(localFavorites,[])
 if(scenario==="rating-love-success")assert.deepEqual(localFavorites,[])
 if(scenario!=="rating-unmount")await unmount()
}else{
 const {ContextMenu}=await import("../../src/components/ContextMenu")
 const kind=scenario.startsWith("queue")?"album":scenario.startsWith("remove")||scenario.startsWith("add")||scenario.startsWith("menu-rating")?"track":"playlist"
 const data:any={id:scenario==="delete-route"?"1":"same",title:"Original",smart:false,playlistItemId:"occurrence",artistName:"Artist",albumName:"Album"}
 if(scenario==="delete-route")history.replaceState(null,"","/playlist/10")
 await act(async()=>{root.render(<ContextMenu/>);menu.getState().show(10,10,kind,data,"same")})
 if(scenario.startsWith("rename")){
  await click("Rename");const input=document.querySelector("input")!;await act(async()=>{const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,"value")!.set!;setter.call(input,"Renamed");input.dispatchEvent(new dom.window.Event("input",{bubbles:true}));input.dispatchEvent(new dom.window.Event("change",{bubbles:true}))});await act(async()=>input.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"Enter",bubbles:true})))
 }else if(scenario.startsWith("delete")){await click("Delete");await click("Delete")}
 else if(scenario.startsWith("remove"))await click("Remove from playlist")
 else if(scenario.startsWith("queue"))await click("Add to bottom")
 else if(scenario.startsWith("add"))await click("Original")
 else if(scenario.startsWith("menu-rating")){await act(async()=>(document.querySelector('button[aria-label="4 stars"]') as HTMLButtonElement).click())}
 assert.equal(calls.length,1)
 if(scenario.endsWith("provider") || scenario.includes("provider-failure"))await replace()
 else if(scenario.endsWith("unmount"))await unmount()
 else if(scenario.endsWith("closed"))await act(async()=>menu.getState().close())
 else if(scenario.endsWith("new-menu"))await act(async()=>menu.getState().show(20,20,"track",{...data,id:"new"}))
 if(scenario.endsWith("failure")){first.reject(Error("synthetic secret"));await settle();if(scenario.includes("provider-failure"))assert.equal(library.getState().error,null);else if(scenario.startsWith("menu-rating"))assert(document.querySelector('[aria-description="Unable to save the rating. Please try again."]'));else assert(library.getState().error?.includes("Unable"))}
 else await resolve([{id:"old-track"}])
 if(scenario==="delete-route"){assert.deepEqual(writes,[["delete","1"]]);assert.equal(location.pathname,"/playlist/10")}
 else if(scenario.endsWith("success")){assert.equal(writes.length,1)}else if(scenario.endsWith("new-menu")){assert.equal(menu.getState().data?.id,"new");assert.equal(menu.getState().open,true);if(scenario.startsWith("queue"))assert.deepEqual(writes,[])}else{assert.deepEqual(writes,[]);if(!scenario.endsWith("failure"))assert.equal(library.getState().error,null)}
 if(!scenario.endsWith("unmount"))await unmount()
}
dom.window.close()
