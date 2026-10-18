import { useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { Button } from "../../../src/components/shared/Button"
import { Checkbox, Switch } from "../../../src/components/shared/Checkbox"
import { Select } from "../../../src/components/shared/Select"
import { DropdownSurface } from "../../../src/components/shared/DropdownSurface"
import {
  MenuItem,
  MenuDivider,
} from "../../../src/components/shared/ContextMenuPrimitives"
import { AppDialog } from "../../../src/components/shared/AppDialog"
import "../../../src/styles.css"

document.body.style.background = "var(--bg-base)"
document.body.style.color = "var(--text-primary)"

function Fixture() {
  const [value, setValue] = useState("balanced"),
    [dialog, setDialog] = useState(false),
    [check, setCheck] = useState(true),
    [saved, setSaved] = useState(""),
    [menu, setMenu] = useState(false),
    [changes, setChanges] = useState(0)
  const form = useRef<HTMLFormElement>(null)
  const options = (
    <>
      <option value="balanced">Balanced</option>
      <option value="unavailable" disabled>
        Unavailable
      </option>
      <optgroup label="Listening">
        <option value="bright">Bright</option>
        <option value="bass">Bass boost</option>
        <option value="quiet">Quiet listening</option>
      </optgroup>
      <optgroup label="Unavailable group" disabled>
        <option value="off">Off</option>
      </optgroup>
    </>
  )
  return (
    <main
      style={{
        maxWidth: 800,
        margin: "auto",
        padding: "clamp(16px,4vw,40px)",
        fontFamily: "Inter Variable, sans-serif",
      }}
    >
      <h1 className="text-2xl font-bold">Playback preferences</h1>
      <p className="mt-2 text-sm text-(--text-secondary)">
        Shared controls in Hibiki’s current palette.
      </p>
      <form
        ref={form}
        className="mt-8 space-y-6"
        onSubmit={(event) => {
          event.preventDefault()
          setSaved(
            JSON.stringify(
              Object.fromEntries(new FormData(event.currentTarget))
            )
          )
        }}
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <label className="block text-sm font-medium">
            Sound profile
            <Select
              name="profile"
              className="mt-2 w-full"
              size="md"
              value={value}
              onChange={(event) => {
                setValue(event.target.value)
                setChanges((n) => n + 1)
              }}
            >
              {options}
            </Select>
          </label>
          <div>
            <label htmlFor="uncontrolled" className="text-sm font-medium">
              Queue order
            </label>
            <Select
              id="uncontrolled"
              name="order"
              className="mt-2 w-full"
              size="md"
              defaultValue="added"
            >
              <option value="added">Date added</option>
              <option value="title">Title</option>
              <option value="artist">Artist</option>
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-8 gap-y-4 text-sm">
          <label className="flex items-center gap-2.5">
            <Checkbox
              name="normalize"
              checked={check}
              onChange={(event) => setCheck(event.target.checked)}
            />
            Normalize volume
          </label>
          <label className="flex items-center gap-2.5">
            <Checkbox indeterminate aria-label="Some columns selected" />
            Some columns selected
          </label>
          <label className="flex items-center gap-2.5">
            <Checkbox disabled />
            Unavailable
          </label>
          <label className="flex items-center gap-2.5">
            <Switch name="waveform" defaultChecked />
            Show waveform
          </label>
        </div>
        <fieldset disabled>
          <legend className="mb-2 text-sm text-(--text-secondary)">
            Disconnected output
          </legend>
          <Select aria-label="Unavailable output" value="balanced">
            {options}
          </Select>
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="md" type="submit">
            Save preferences
          </Button>
          <Button size="md" onClick={() => setDialog(true)}>
            Choose output
          </Button>
          <Button size="md" variant="ghost" type="reset">
            Reset order
          </Button>
          <Button size="md" disabled>
            Up to date
          </Button>
        </div>
        <output
          className="block text-xs break-all text-(--text-secondary)"
          data-changes={changes}
        >
          {saved || "No changes saved"}
        </output>
      </form>
      <div className="relative mt-8">
        <Button
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          Playlist actions
        </Button>
        {menu && (
          <DropdownSurface
            role="menu"
            aria-label="Playlist actions"
            className="absolute top-full mt-2 w-56"
          >
            <MenuItem label="Play next" onClick={() => setMenu(false)} />
            <MenuItem label="Add to queue" onClick={() => setMenu(false)} />
            <MenuDivider />
            <MenuItem
              label="Remove playlist"
              danger
              onClick={() => setMenu(false)}
            />
            <MenuItem label="Download" disabled onClick={() => {}} />
          </DropdownSurface>
        )}
      </div>
      <label className="mt-10 block text-sm">
        Long list
        <Select aria-label="Long list" className="mt-2 w-full" value="15">
          {Array.from({ length: 40 }, (_, i) => (
            <option value={i} key={i}>
              Output {String(i).padStart(2, "0")}
            </option>
          ))}
        </Select>
      </label>
      {dialog && (
        <AppDialog
          title="Output settings"
          onClose={() => setDialog(false)}
          className="max-w-md"
        >
          <label className="block text-sm">
            Output device
            <Select className="mt-2 w-full" size="md" defaultValue="dac">
              <option value="dac">USB DAC</option>
              <option value="speakers">Built-in speakers</option>
              <option value="headphones">Headphones</option>
            </Select>
          </label>
          <p className="mt-4 text-sm text-(--text-secondary)">
            The dropdown stays above this modal and keeps its palette.
          </p>
        </AppDialog>
      )}
    </main>
  )
}
createRoot(document.getElementById("root")!).render(<Fixture />)
