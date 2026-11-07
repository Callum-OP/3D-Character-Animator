import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import React from 'react'

vi.mock('../three/scene.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, applyModelMaterials: () => {}, resetActiveDangle: vi.fn(), collectActiveDangleDescendants: (names) => names }
})

import BonePanel from '../panels/BonePanel.jsx'
import IkPinsSection from '../panels/IkPinsSection.jsx'
import FlattenerSection from '../panels/FlattenerSection.jsx'
import { FxCollapse, FxItem, FxSection, FxCheck, FxButtons } from '../panels/FxCards.jsx'
import { useStore } from '../store.js'

const st = () => useStore.getState()
afterEach(cleanup)

const bones = [
  { name: 'Head', label: 'Head', depth: 0, deform: true },
  { name: 'Hair_1', label: 'Hair 1', depth: 1, deform: true },
  { name: 'Hair_2', label: 'Hair 2', depth: 2, deform: true },
]
const chain = { id: 'c1', name: 'Hair', type: 'dangle', boneNames: ['Hair_1', 'Hair_2'], stiffness: 0.15, gravity: 1, damping: 0.8 }

beforeEach(() => {
  useStore.setState({
    modelInfo: { meshes: [], bones },
    selectedBoneName: null,
    selectedBoneNames: [],
    dangleEnabled: true,
    dangleChains: [],
    ikPins: [],
    flatteners: [],
    sceneObjects: [],
    mode: 'pose',
  })
})

describe('shared card pieces', () => {
  it('an item shows its title and pills, and its controls only once opened', () => {
    const { container } = render(
      <FxItem title="Hair" pills={['Dangle', '2 bones']}>
        <button>Reset</button>
      </FxItem>,
    )
    expect(screen.getByText('Hair')).toBeTruthy()
    expect(screen.getByText('Dangle')).toBeTruthy()
    expect(screen.getByText('2 bones')).toBeTruthy()
    expect(container.querySelector('details').open).toBe(false)
  })

  it('a section badge counts, a check box reports a plain true / false, a collapse shows title and hint', () => {
    const seen = []
    render(
      <>
        <FxSection step="STEP 1" title="Things" count={3} countLabel="3 things" label="Things" />
        <FxCheck checked={false} onChange={(v) => seen.push(v)}>Switch</FxCheck>
        <FxCollapse title="Add bones" hint="hair, hoods, capes…">body</FxCollapse>
      </>,
    )
    expect(screen.getByLabelText('3 things').textContent).toBe('3')
    fireEvent.click(screen.getByLabelText('Switch'))
    expect(seen).toEqual([true])
    expect(screen.getByText('Add bones')).toBeTruthy()
    expect(screen.getByText('hair, hoods, capes…')).toBeTruthy()
  })
})

describe('Pose area sections use the card layout', () => {
  it('pose controls and the bone list are collapsible and open by default', () => {
    const { container } = render(<BonePanel />)
    const details = [...container.querySelectorAll('.fx-card')]
    expect(details.map((card) => card.querySelector('summary').textContent.trim())).toEqual(
      expect.arrayContaining(['Pose controlsjoint controls', 'Bones3 joints', 'Bone physicsswing and drape', 'IK pinshold limbs on markers', 'Flattenerflatten a head toward camera']),
    )
    expect(details[0].open).toBe(true)
    expect(details[1].open).toBe(true)
    expect(details.slice(2).every((card) => !card.open)).toBe(true)
    fireEvent.click(details[0].querySelector('summary'))
    expect(details[0].open).toBe(false)
  })

  it('Bone Physics: intro card, add card with disabled buttons until a bone is selected', () => {
    render(<BonePanel />)
    fireEvent.click(screen.getByText('Bone physics'))
    expect(screen.getByLabelText('Bone physics')).toBeTruthy()
    expect(screen.getByText('Make bones swing and drape')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add selected as dangle' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Add selected as rigged cloth' }).disabled).toBe(true)
    expect(screen.getByText(/No bone physics chains yet/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Enable bone physics'))
    expect(st().dangleEnabled).toBe(false)
  })

  it('Bone Physics: a chain is an item with its type and bone count, and its controls still work', () => {
    useStore.setState({ dangleChains: [chain] })
    render(<BonePanel />)
    fireEvent.click(screen.getByText('Bone physics'))
    const list = screen.getByLabelText('Bone physics chains')
    expect(within(list).getByText('Hair')).toBeTruthy()
    expect(within(list).getByText('2 bones')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Hair physics type'), { target: { value: 'cloth' } })
    expect(st().dangleChains[0].type).toBe('cloth')
    expect(list.querySelector('.fx-zone-area').textContent).toBe('Rigged cloth') // the pill follows the type
    fireEvent.click(screen.getByLabelText('Collide with other meshes'))
    expect(st().dangleChains[0].collideWithMesh).toBe(true)
    fireEvent.click(screen.getByLabelText('Remove this chain'))
    expect(st().dangleChains).toHaveLength(0)
  })

  it('IK pins and Flattener have intro and add cards', () => {
    render(
      <>
        <IkPinsSection />
        <FlattenerSection />
      </>,
    )
    fireEvent.click(screen.getByText('IK pins'))
    fireEvent.click(screen.getByText('Flattener'))
    expect(screen.getByLabelText('IK pins')).toBeTruthy()
    expect(screen.getByLabelText('Add an IK pin')).toBeTruthy()
    expect(screen.getByText('No IK pins yet.')).toBeTruthy()
    expect(screen.getByLabelText('Flattener')).toBeTruthy()
    expect(screen.getByLabelText('Add a flattener')).toBeTruthy()
    expect(screen.getByText('No flattener yet.')).toBeTruthy()
  })
})

describe('FxButtons layouts', () => {
  const rows = (props) => {
    const { container } = render(
      <FxButtons {...props}>
        <button className="btn fx-btn-main">Pick faces</button>
        <button className="btn secondary">Clear</button>
      </FxButtons>,
    )
    return container.firstChild
  }

  it('stays a wrapping row of pills by default', () => {
    const row = rows({})
    expect(row.className).toBe('fx-buttons')
    expect(row.style.gridTemplateColumns).toBe('')
  })

  it('wide makes one even row, and keeps the main button marker for the double-width slot', () => {
    const row = rows({ wide: true })
    expect(row.className).toBe('fx-buttons is-wide')
    expect(row.querySelector('.fx-btn-main').textContent).toBe('Pick faces')
  })

  it('columns makes an even grid with that many columns', () => {
    const row = rows({ columns: 2 })
    expect(row.className).toBe('fx-buttons is-grid')
    expect(row.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))')
  })
})
