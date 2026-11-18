import { NO_TRAIN, WALK_HOME, WEEKS, hhmm, rank, weekOf } from './lib.js'

// 후보 장소 기본값: 모임이 자주 잡히는 역. 시간표에 있는 역만 쓰임
const HUBS = [
  '강남', '홍대입구', '건대입구', '잠실', '신촌', '종로3가', '사당', '왕십리', '합정', '성수',
  '을지로입구', '이태원', '혜화', '신림', '노원', '고속터미널', '서울역', '동대문역사문화공원',
  '천호', '연신내', '수유', '교대', '신도림', '여의도', '광화문', '공덕', '압구정', '신사',
]
const SHOWN = 10 // shortcut: 상위 10곳만 표시, 전체 보기가 필요해지면 더 보기 버튼 추가

const $ = (id) => document.getElementById(id)
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

// 상태는 주소에 담음: 링크를 단톡방에 올리면 같은 결과가 열림
const query = new URLSearchParams(location.search)
const state = {
  people: (query.get('p') ?? '~,~').split(',').map((pair) => {
    const [name = '', home = ''] = pair.split('~')
    return { name, home }
  }),
  extra: (query.get('c') ?? '').split(',').filter(Boolean),
  walk: Number(query.get('w')) || 10,
  date: query.get('d') || new Date().toLocaleDateString('sv-SE'),
  holiday: query.get('h') === '1',
}
$('walk').value = String(state.walk)
$('date').value = state.date
$('holiday').checked = state.holiday

// 모임 날짜의 요일에 맞는 막차 표를 불러옴 (평일 / 토요일 / 일요일·공휴일)
let data = null
let lines = new Map()
let week = ''
/** 반환값이 false면 기다리는 사이 날짜가 또 바뀐 것: 이 응답은 버리고 화면도 그리지 않음 */
async function load() {
  const next = weekOf(state.date, state.holiday)
  if (next === week) return true
  week = next
  const loaded = await fetch(`data/last-${next}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  if (week !== next) return false // 늦게 도착한 다른 요일 표가 현재 표를 덮어쓰면 틀린 막차 시각이 나옴
  data = loaded
  lines = new Map((data?.stations ?? []).map((s) => [s.name, s.lines]))
  $('notice').hidden = Boolean(data)
  $('notice').textContent = `${WEEKS[week]} 시간표 데이터가 없습니다. 인증키를 .env에 넣고 npm run data를 실행하세요.`
  $('source').textContent = data
    ? `${data.source} · ${data.generated} 수집 · 환승 ${data.transfer}분 가정 · 역에서 집까지는 계산하지 않습니다.`
    : ''
  $('stations').replaceChildren(...(data?.stations ?? []).map((s) => el('option', { value: s.name })))
  return true
}

function save() {
  const q = new URLSearchParams({
    p: state.people.map((p) => `${p.name}~${p.home}`).join(','),
    w: String(state.walk),
    d: state.date,
  })
  if (state.holiday) q.set('h', '1')
  if (state.extra.length) q.set('c', state.extra.join(','))
  history.replaceState(null, '', `?${q}`)
}

function renderPeople() {
  $('people').replaceChildren(
    ...state.people.map((person, i) => {
      const unknown = Boolean(data && person.home && !lines.has(person.home))
      const name = el('input', {
        value: person.name,
        placeholder: '이름',
        autocomplete: 'off',
        ariaLabel: `참석자 ${i + 1} 이름`,
        oninput: (e) => {
          person.name = e.target.value.replace(/[~,]/g, '')
          renderResults()
        },
      })
      const home = el('input', {
        value: person.home,
        placeholder: '집 근처 역',
        autocomplete: 'off',
        ariaLabel: `참석자 ${i + 1} 집 근처 역`,
        ariaInvalid: String(unknown),
        onchange: (e) => {
          person.home = e.target.value.trim().replace(/역$/, '')
          renderPeople()
          renderResults()
        },
      })
      home.setAttribute('list', 'stations')
      const remove = el('button', {
        type: 'button',
        className: 'remove',
        textContent: '×',
        ariaLabel: `참석자 ${i + 1} 삭제`,
        disabled: state.people.length <= 2,
        onclick: () => {
          state.people.splice(i, 1)
          renderPeople()
          renderResults()
        },
      })
      const row = el('li', {}, name, home, remove)
      if (unknown) row.append(el('p', { className: 'error', textContent: '목록에 없는 역입니다. 서울교통공사 구간만 지원합니다.' }))
      return row
    }),
  )
}

function leaveText(leave) {
  if (leave === WALK_HOME) return '걸어서'
  if (leave === NO_TRAIN) return '막차 없음'
  return hhmm(leave)
}

/** 해산 시각에 울리는 캘린더 일정(.ics). 자정을 넘기면 다음 날짜 */
function downloadIcs(result) {
  const start = new Date(`${state.date}T00:00:00`)
  start.setMinutes(result.end)
  const stamp = (d) =>
    `${d.toLocaleDateString('sv-SE').replaceAll('-', '')}T${d.toTimeString().slice(0, 8).replaceAll(':', '')}`
  const end = new Date(start.getTime() + 5 * 60000)
  const who = result.leaves.map((l) => `${l.name || l.home} ${leaveText(l.board)} 승차`).join(', ')
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//makcha-moim//KO',
    'BEGIN:VEVENT',
    `UID:${Date.now()}@makcha-moim`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:막차 해산 (${result.place})`,
    `DESCRIPTION:${who}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT10M',
    'ACTION:DISPLAY',
    'DESCRIPTION:10분 뒤 막차 해산',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
  const link = el('a', {
    href: URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })),
    download: `막차-${result.place}.ics`,
  })
  link.click()
  URL.revokeObjectURL(link.href)
}

function renderResults() {
  save()
  $('weekend').hidden = week === '1'
  $('weekend').textContent = `${WEEKS[week]} 시간표로 계산했습니다.`

  const people = state.people.filter((p) => lines.has(p.home))
  const ready = Boolean(data) && people.length >= 2
  $('empty').hidden = ready
  $('copy').hidden = !ready
  if (!ready) return $('results').replaceChildren()

  const results = rank(data, people, [...new Set([...state.extra, ...HUBS])], state.walk)
  $('results').replaceChildren(
    ...results.slice(0, SHOWN).map((result, i) => {
      const none = result.end === NO_TRAIN
      const earliest = Math.min(...result.leaves.map((l) => (l.leave === NO_TRAIN ? Infinity : l.leave)))
      const who = el('p', { className: 'who' })
      result.leaves.forEach((l, j) => {
        const text = `${l.name || l.home} ${leaveText(l.leave)}`
        // 가장 먼저 일어나야 하는 사람(해산 시각을 정하는 사람)을 굵게
        who.append(j ? ' · ' : '', l.leave === earliest || l.leave === NO_TRAIN ? el('b', { textContent: text }) : text)
      })
      const row = el(
        'li',
        { className: none ? 'none' : '' },
        el(
          'div',
          { className: 'place' },
          result.place,
          ...(lines.get(result.place) ?? []).map((n) => {
            const badge = el('span', { className: 'line', textContent: n, ariaLabel: `${n}호선` })
            badge.style.background = `var(--line-${n})`
            return badge
          }),
        ),
        el(
          'div',
          { className: 'time' },
          ...(none
            ? ['막차 없음']
            : result.end === WALK_HOME
              ? ['제한 없음']
              : [el('small', { textContent: i === 0 ? '가장 늦게까지' : '해산' }), hhmm(result.end)]),
        ),
        who,
      )
      if (!none && result.end !== WALK_HOME) {
        row.append(
          el('button', {
            type: 'button',
            className: 'ghost ics',
            textContent: '캘린더에 해산 알림 추가',
            onclick: () => downloadIcs(result),
          }),
        )
      }
      return row
    }),
  )
}

$('add-person').onclick = () => {
  state.people.push({ name: '', home: '' })
  renderPeople()
  $('people').lastElementChild.querySelector('input').focus()
}
$('walk').onchange = (e) => {
  state.walk = Number(e.target.value)
  renderResults()
}
// 날짜나 공휴일 표시가 바뀌면 시간표가 달라질 수 있음
async function reload() {
  if (!(await load())) return
  renderPeople()
  renderResults()
}
$('date').onchange = (e) => {
  state.date = e.target.value || state.date
  reload()
}
$('holiday').onchange = (e) => {
  state.holiday = e.target.checked
  reload()
}
$('extra').onchange = (e) => {
  const place = e.target.value.trim().replace(/역$/, '')
  if (lines.has(place) && !state.extra.includes(place)) state.extra.unshift(place)
  e.target.value = ''
  renderResults()
}
$('copy').onclick = async () => {
  await navigator.clipboard.writeText(location.href)
  $('copy').textContent = '복사했습니다'
  setTimeout(() => ($('copy').textContent = '이 결과 링크 복사'), 1500)
}

reload()
