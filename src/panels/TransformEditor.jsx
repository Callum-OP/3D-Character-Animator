import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

const AXES = ['X', 'Y', 'Z']

function displayValues(transform) {
  const rotation = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...transform.quaternion), 'XYZ')
  return {
    position: transform.position.map((value) => String(Number(value.toFixed(3)))),
    rotation: [rotation.x, rotation.y, rotation.z].map((value) => String(Number(THREE.MathUtils.radToDeg(value).toFixed(2)))),
    scale: transform.scale.map((value) => String(Number(value.toFixed(3)))),
  }
}

function sameValues(a, b) {
  return ['position', 'rotation', 'scale'].every((field) =>
    a[field].every((value, index) => value === b[field][index]),
  )
}

export default function TransformEditor({ label, transform, readTransform, onCommit }) {
  const [draft, setDraft] = useState(() => displayValues(transform))
  const editing = useRef(false)
  const readTransformRef = useRef(readTransform)
  readTransformRef.current = readTransform
  const signature = [
    ...transform.position,
    ...transform.quaternion,
    ...transform.scale,
  ].join(',')

  useEffect(() => {
    setDraft(displayValues(transform))
  }, [signature])

  useEffect(() => {
    const timer = setInterval(() => {
      if (editing.current) return
      const live = readTransformRef.current?.()
      if (live) {
        const next = displayValues(live)
        setDraft((current) => sameValues(current, next) ? current : next)
      }
    }, 250)
    return () => clearInterval(timer)
  }, [])

  function commit(field) {
    const values = draft[field].map((value) => value.trim() === '' ? NaN : Number(value))
    if (values.some((value) => !Number.isFinite(value))) {
      const live = readTransformRef.current?.() || transform
      setDraft(displayValues(live))
      editing.current = false
      return
    }
    if (field === 'rotation') {
      const quaternion = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(...values.map((value) => THREE.MathUtils.degToRad(value)), 'XYZ'),
      )
      onCommit({ quaternion: quaternion.toArray() })
    } else {
      onCommit({ [field]: values })
    }
    editing.current = false
    const live = readTransformRef.current?.()
    if (live) setDraft(displayValues(live))
  }

  return (
    <div className="scene-transform-editor">
      <h3>{label} transform</h3>
      {[
        ['position', 'Position'],
        ['rotation', 'Rotation (°)'],
        ['scale', 'Scale'],
      ].map(([field, title]) => (
        <label className="scene-transform-row" key={field}>
          <span>{title}</span>
          <span className="scene-transform-values">
            {AXES.map((axis, index) => (
              <input
                key={axis}
                type="number"
                step={field === 'rotation' ? 1 : 0.01}
                aria-label={`${label} ${title} ${axis}`}
                title={`${title} ${axis}`}
                value={draft[field][index]}
                onFocus={() => { editing.current = true }}
                onChange={(event) => {
                  const next = [...draft[field]]
                  next[index] = event.target.value
                  setDraft({ ...draft, [field]: next })
                }}
                onBlur={() => commit(field)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                }}
              />
            ))}
          </span>
        </label>
      ))}
    </div>
  )
}
