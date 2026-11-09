import { useState } from 'react'
import { useStore } from '../store.js'
import { FxSection, FxField, FxHelp, FxButtons } from './FxCards.jsx'
import {
  listMeshCopySources,
  copyAddedBonesFromMesh,
  copyMeshPhysicsFromMesh,
  describeBonesCopy,
  describePhysicsCopy,
} from '../three/copyEffects.js'

// "Copy from another mesh": the same idea as copying between characters, for one part. kind is 'bones'
// (Add bones rigs that sit on the source mesh) or 'physics' (its Mesh Physics effects).

export default function CopyFromMesh({ kind, targetMesh }) {
  useStore((s) => s.characterOrder)
  useStore((s) => s.meshOverrides)
  useStore((s) => s.meshVersion)
  const meshOverrides = useStore((s) => s.meshOverrides)
  const [pick, setPick] = useState('')
  const [message, setMessage] = useState('')

  const sources = targetMesh ? listMeshCopySources(kind, targetMesh) : []
  if (!sources.length) return null
  const nameOf = (item) => meshOverrides[item.mesh.uuid]?.name || item.mesh.name || 'Part'
  const selected = sources.find((s) => s.mesh.uuid === pick) || sources[0]

  const copy = () => {
    const result = kind === 'bones'
      ? describeBonesCopy(copyAddedBonesFromMesh(selected.characterId, selected.mesh, targetMesh))
      : describePhysicsCopy(copyMeshPhysicsFromMesh(selected.characterId, selected.mesh, targetMesh))
    setMessage(result)
  }

  return (
    <FxSection step="COPY" title="Copy from another mesh" label={kind === 'bones' ? 'Copy added bones from another mesh' : 'Copy mesh physics from another mesh'}>
      <FxField label="Copy from" title="Another mesh that already has this effect">
        <select value={selected.mesh.uuid} onChange={(e) => { setPick(e.target.value); setMessage('') }} aria-label={kind === 'bones' ? 'Mesh to copy added bones from' : 'Mesh to copy mesh physics from'}>
          {sources.map((s) => (
            <option key={s.mesh.uuid} value={s.mesh.uuid}>{`${s.characterName} · ${nameOf(s)}`}</option>
          ))}
        </select>
      </FxField>
      <FxButtons wide>
        <button className="btn secondary" onClick={copy} title="Copy it onto the selected part (areas are matched by position if the meshes differ)">
          {kind === 'bones' ? 'Copy added bones here' : 'Copy mesh physics here'}
        </button>
      </FxButtons>
      {message && <FxHelp>{message}</FxHelp>}
    </FxSection>
  )
}
