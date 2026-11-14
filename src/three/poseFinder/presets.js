export const POSE_PRESETS = {
  standing: {
    label: 'Standing',
    description: 'For standing, walking and other mostly upright movement.',
    settings: { sampleFps: 10, outFps: 30, smoothing: 'medium', footLock: true, levelCamera: true, posture: 'auto', levelFeet: true, limitJoints: true, lowerArms: 'slight', ground: 'strict', groundReference: 'feet', lockFeet: false },
  },
  lying: {
    label: 'Lying down',
    description: 'For poses on a bed or floor. Preserves the body orientation instead of forcing the feet down.',
    settings: { sampleFps: 10, outFps: 30, smoothing: 'medium', footLock: false, levelCamera: false, posture: 'off', levelFeet: false, limitJoints: true, lowerArms: 'slight', ground: 'natural', groundReference: 'body', lockFeet: false },
  },
  flips: {
    label: 'Flips',
    description: 'For front flips and back flips. Keeps airborne motion and steadies detected planted feet.',
    settings: { sampleFps: 30, outFps: 30, smoothing: 'low', footLock: true, contactMode: 'screen', levelCamera: false, posture: 'off', levelFeet: true, limitJoints: true, lowerArms: 'slight', ground: 'natural', groundReference: 'body', lockFeet: false },
  },
  adaptable: {
    label: 'Adaptable',
    description: 'For mixed movement, such as walking, falling, rolling and lying down. Releases foot contacts when the body tilts.',
    settings: { sampleFps: 30, outFps: 30, smoothing: 'low', footLock: true, contactMode: 'screen', motionProfile: 'mixed', levelCamera: false, posture: 'off', levelFeet: true, limitJoints: true, lowerArms: 'slight', ground: 'natural', groundReference: 'body', lockFeet: false },
  },
}
