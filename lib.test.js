import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_TRAIN,
  WALK_HOME,
  buildConnections,
  hhmm,
  latestDepartures,
  rank,
  stationName,
  toMin,
  weekOf,
} from './lib.js'

test('toMin / hhmm', () => {
  assert.equal(toMin('23:30:00'), 1410)
  assert.equal(toMin('24:46:30'), 1486.5)
  assert.equal(toMin('00:10:00'), 1450) // 자정 넘은 열차는 24시 이후로 이어서 셈
  assert.equal(toMin('00:00:00'), null) // 빈 칸
  assert.equal(hhmm(1486.5), '00:46')
  assert.equal(hhmm(1410), '23:30')
})

test('weekOf', () => {
  assert.equal(weekOf('2026-11-20'), '1') // 금요일 밤은 평일 시간표
  assert.equal(weekOf('2026-11-21'), '2') // 토요일
  assert.equal(weekOf('2026-11-22'), '3') // 일요일
  assert.equal(weekOf('2026-11-20', true), '3') // 공휴일로 표시한 평일
})

test('stationName', () => {
  assert.equal(stationName('총신대입구(이수)'), '이수')
  assert.equal(stationName('강남'), '강남')
})

// 가상 노선 두 개. A선: a1 → a2 → a3, B선: b1 → b2. a2와 b1이 같은 역(환승)
const row = (line, train, node, arrive, left) => ({
  LINE_NUM: line,
  TRAIN_NO: train,
  STATION_CD: node,
  ARRIVETIME: arrive,
  LEFTTIME: left,
})
const rows = [
  // A선 막차 직전 열차와 막차
  row('A', '1', 'a1', '00:00:00', '23:00:00'),
  row('A', '1', 'a2', '23:10:00', '23:11:00'),
  row('A', '1', 'a3', '23:20:00', '00:00:00'),
  row('A', '2', 'a1', '00:00:00', '23:40:00'),
  row('A', '2', 'a2', '23:50:00', '23:51:00'),
  row('A', '2', 'a3', '24:00:00', '00:00:00'),
  // B선 막차
  row('B', '9', 'b1', '00:00:00', '23:30:00'),
  row('B', '9', 'b2', '23:45:00', '00:00:00'),
]
const siblings = new Map([
  ['a2', ['b1']],
  ['b1', ['a2']],
])

test('buildConnections', () => {
  const connections = buildConnections(rows)
  assert.equal(connections.length, 5)
  assert.deepEqual(connections[0], { from: 'a2', to: 'a3', dep: 1431, arr: 1440 }) // 가장 늦게 떠나는 구간이 맨 앞
})

test('latestDepartures', () => {
  const connections = buildConnections(rows)

  // 집이 a3: 같은 노선은 막차 시각 그대로
  const toA3 = latestDepartures(connections, siblings, ['a3'])
  assert.equal(toA3.get('a1'), 1420) // 23:40
  assert.equal(toA3.get('a2'), 1431) // 23:51
  assert.equal(toA3.get('b1'), 1426) // a2 막차 23:51에서 환승 5분을 뺌
  assert.equal(toA3.has('b2'), false) // b2에서 a3로 가는 열차 없음

  // 집이 b2: A선 막차(23:50 도착)로는 B선 막차(23:30 출발)를 못 탐. 앞 열차(23:00 출발)를 타야 함
  const toB2 = latestDepartures(connections, siblings, ['b2'])
  assert.equal(toB2.get('b1'), 1410) // 23:30
  assert.equal(toB2.get('a2'), 1405) // 환승 5분
  assert.equal(toB2.get('a1'), 1380) // 23:00 열차 (23:10 도착 ≤ 23:25)
})

test('rank', () => {
  const data = {
    stations: [{ name: '가' }, { name: '나' }, { name: '다' }],
    // last[집][장소]
    last: [
      [WALK_HOME, 1420, 1400],
      [1430, WALK_HOME, NO_TRAIN],
      [1410, 1390, WALK_HOME],
    ],
  }
  const people = [
    { name: '민수', home: '가' },
    { name: '지영', home: '나' },
  ]
  const result = rank(data, people, ['가', '나', '다', '없는역'], 10)
  assert.deepEqual(
    result.map((r) => [r.place, r.end]),
    [
      ['가', 1420], // 민수는 걸어서, 지영은 23:50 승차 → 23:40 해산
      ['나', 1410], // 민수 23:40 승차 → 23:30 해산
      ['다', NO_TRAIN], // 지영이 귀가할 열차가 없음
    ],
  )
  assert.equal(result[0].leaves[0].leave, WALK_HOME)
})
