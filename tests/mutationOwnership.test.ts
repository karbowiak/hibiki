import { expect, test } from "bun:test"
import { resolve } from "node:path"
for (const scenario of ["queue-artist-success","queue-artist-provider","sidebar-provider","sidebar-unmount","sidebar-roundtrip","sidebar-partial-failure","rename-provider","rename-unmount","rename-success","rename-failure","rename-provider-failure","delete-provider","delete-success","delete-route","delete-failure","remove-provider","remove-success","queue-provider","queue-new-menu","queue-closed","add-provider","add-new-menu","add-failure","menu-rating-new-menu","rating-provider","rating-unmount","rating-row","rating-failure","rating-success","rating-capability","rating-love-success","rating-love-failure","rating-album-success"]) {
 test(`mounted mutation ownership: ${scenario}`, async () => {
  const child=Bun.spawn([process.execPath,"tests/fixtures/mutationOwnership.tsx",scenario],{cwd:resolve(import.meta.dir,".."),stdout:"pipe",stderr:"pipe"})
  const [status,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
  expect({status,output:stdout+stderr}).toEqual({status:0,output:""})
 })
}
