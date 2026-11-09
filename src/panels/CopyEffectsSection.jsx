import { useState } from 'react'
import { useStore } from '../store.js'
import { FxEditor, FxField, FxHelp, FxButtons } from './FxCards.jsx'
import {
  listCopySources,
  copyAddedBonesFromCharacter,
  copyMeshPhysicsFromCharacter,
  describeBonesCopy,
  describePhysicsCopy,
} from '../three/copyEffects.js'

// Copy the Add bones rigs, or the Mesh Physics, from another loaded character onto the active one. Parts and
// bones are matched by name, so it suits characters built on the same rig and mesh layout.

export default function CopyEffectsSection() {
  useStore((s) => s.characterOrder)
  useStore((s) => s.meshVersion)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const [sourceId, setSourceId] = useState('')
  const [message, setMessage] = useState('')

  const sources = activeCharacterId ? listCopySources() : []
  const source = sources.find((s) => s.id === sourceId) || sources[0] || null

  if (!sources.length) {
    return (
      <FxEditor>
        <FxHelp>Load a second character to copy its added bones or mesh physics onto this one.</FxHelp>
      </FxEditor>
    )
  }

  return (
    <FxEditor>
      <FxHelp>
        Copies onto the selected character. Parts and bones are matched by name, so it works best between characters
        with the same rig and mesh names. If a part has the same number of faces, proportions barely matter; if not,
        areas are matched by position and the characters should be built to similar proportions.
      </FxHelp>
      <FxField label="Copy from" title="The character to copy from">
        <select value={source.id} onChange={(e) => { setSourceId(e.target.value); setMessage('') }} aria-label="Character to copy effects from">
          {sources.map((s) => (
            <option key={s.id} value={s.id}>{`${s.name} · ${s.rigs} rig${s.rigs === 1 ? '' : 's'}, ${s.physicsParts} physics part${s.physicsParts === 1 ? '' : 's'}`}</option>
          ))}
        </select>
      </FxField>
      <FxButtons wide>
        <button
          className="btn secondary"
          disabled={!source.rigs}
          title="Rebuild this character's added bones (and their swing physics) from the chosen one"
          onClick={() => setMessage(describeBonesCopy(copyAddedBonesFromCharacter(source.id)))}
        >
          Copy added bones
        </button>
        <button
          className="btn secondary"
          disabled={!source.physicsParts}
          title="Copy the soft cloth and swing effects of every matching part"
          onClick={() => setMessage(describePhysicsCopy(copyMeshPhysicsFromCharacter(source.id)))}
        >
          Copy mesh physics
        </button>
      </FxButtons>
      {message && <FxHelp>{message}</FxHelp>}
    </FxEditor>
  )
}
