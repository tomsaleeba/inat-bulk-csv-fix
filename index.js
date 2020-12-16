const Axios = require('axios')
const csv = require('csv-parser')
const fs = require('fs')
const dayjs = require('dayjs')
const customParseFormat = require('dayjs/plugin/customParseFormat')
dayjs.extend(customParseFormat)

const cachedInatDataFilename = 'cached.json'
const fields = [
  'id',
  'observed_on',
  'latitude',
  'longitude',
  'species_guess',
  'private_latitude',
  'private_longitude',
]
let inatData = null
const sessionId = process.env.SESSIONID
if (!sessionId) {
  log('WARNING: no SESSIONID env var supplied, making call as public')
}
const jwt = process.env.JWT
if (!jwt) {
  log('WARNING: no JWT env var, things will probably fail')
}
const axios = Axios.create({
  baseURL: 'https://api.inaturalist.org/v1',
  headers: {
    authorization: `Bearer ${jwt}`,
  },
})

const zeroFound = 'isZero'
const tooManyFound = 'isTooMany'

// hard coded alternate names for species. If the script finds new values, it
// will print them out at the end of a run and you can put that back into the
// code.
const altSpecies = {
  'Acianthus caudatus': 'Mayfly orchid', // 320644
  'Caladenia carnea': 'Pink Lady Fingers', // 321090
  'Caladenia deformis': ['Pheladenia deformis', 'Blue Fairy Orchid'],
  'Caladenia latifolia': 'Pink Fairies',
  'Caladenia reticulata': 'veined spider orchid',
  'Caladenia tentaculata': 'eastern mantis orchid',
  'Calochilus robertsonii': 'Purple Beard Orchid',
  'Corybas diemenicus': 'veined helmet-orchid',
  'Diuris behrii': 'golden cowslips',
  'Diuris pardina': 'Leopard Orchid',
  'Pterostylis nana': 'dwarf greenhood',
  'Pterostylis pedunculata': 'maroonhood',
  'Pterostylis plumosa': 'bearded greenhood',
  'Pterostylis sanguinea': 'Red-banded Greenhood',
  'Thelymitra benthamiana': 'blotched sun-orchid',
  Thelymitra: 'Sun Orchids',
  'Thelymitra rubra': 'salmon sun-orchid',
}
let isAltSpeciesDirty = false

// we have to do the matching by hand for some records. It's easier than
// writing the logic to match all the fields, or for some records, theres are
// duplicates so we just randomly assign IDs.
const forcedMatches = {
  // 117 and 120 are identical except for the individual count
  117: 60596430,
  120: 60596427,
  134: 60596476, // has the 10-30%
  // 129, 132 and 133 are identical except for the individual count
  129: 60596475,
  130: 60596464,
  131: 60596470,
  132: 60596472,
  133: 60596461,
  // the species name changed on 33
  33: 60596314,
}

const orchidTypeId = 12038
const accuracyId = 11988
const countId = 12043

const wowProjectId = 65697

async function doit() {
  const csvData = await readCsv()
  let zeroCount = 0
  let foundCount = 0
  let tooManyCount = 0
  const foundSet = new Set()
  for (i in csvData) {
    const csvRowNum = parseInt(i) + 2
    log('Process CSV row ' + csvRowNum)
    const curr = csvData[i]
    const found = await findRemote(curr, csvRowNum)
    let val = null
    if (found[zeroFound]) {
      zeroCount += 1
      val = null
    } else if (found[tooManyFound]) {
      tooManyCount += 1
      const ids = found[tooManyFound]
      val = `${ids.length} records (${JSON.stringify(ids)})`
    } else {
      foundCount += 1
      if (foundSet.has(found)) {
        throw new Error(`Duplicate match for csv row=${i} matched ID=${found}`)
      }
      val = found
    }
    // const csvRowNumStr = '    ' + csvRowNum
    // const num = csvRowNumStr.substring(csvRowNumStr.length - 3)
    // log(`${num}   ${val}`)
    log('Found remote record ID=' + found)
    const remoteRecord = inatData.find(e => e.id === found)
    await updateOnRemote(curr, remoteRecord)
  }
  if (isAltSpeciesDirty) {
    log('altSpecies', altSpecies)
  }
  log(
    `Done. Found=${foundCount}, zero=${zeroCount},` +
      ` too many=${tooManyCount}`,
  )
}

doit().catch(err => {
  log('Failtown', err)
})

async function findRemote(csvRecord, rowNum) {
  const forcedMatch = forcedMatches[rowNum]
  if (forcedMatch) {
    return forcedMatch
  }
  if (!inatData) {
    inatData = await getDataFromInat()
  }
  const matchingLatLng = inatData.filter(e => {
    const isPublicCoordMatch =
      e.latitude === csvRecord.lat && e.longitude === csvRecord.lng
    const isPrivateCoordMatch =
      e.private_latitude === csvRecord.lat &&
      e.private_longitude === csvRecord.lng
    return isPublicCoordMatch || isPrivateCoordMatch
  })
  if (matchingLatLng.length === 1) {
    return matchingLatLng[0].id
  }
  const alsoMatchingDate = matchingLatLng.filter(
    e => e.observed_on === csvRecord.date.val,
  )
  if (alsoMatchingDate.length === 1) {
    return alsoMatchingDate[0].id
  }
  const cSpecies = csvRecord.speciesGuess
  const otherNames = altSpecies[cSpecies]
  const alsoMatchingSpecies = alsoMatchingDate.filter(e => {
    const speciesMatches = e.species_guess === cSpecies
    let isOtherNameMatch = false
    if (Array.isArray(otherNames)) {
      isOtherNameMatch = otherNames.includes(e.species_guess)
    } else {
      isOtherNameMatch = e.species_guess === otherNames
    }
    return speciesMatches || isOtherNameMatch
  })
  if (alsoMatchingSpecies.length === 1) {
    return alsoMatchingSpecies[0].id
  }
  if (alsoMatchingSpecies.length === 0) {
    if (!otherNames) {
      await lookupOtherName(csvRecord.speciesGuess)
    }
    return { [zeroFound]: true }
  }
  return { [tooManyFound]: alsoMatchingSpecies.map(e => e.id) }
}

async function lookupOtherName(name) {
  log('Looking up other name for ' + name)
  const url =
    'https://api.inaturalist.org/v1/taxa?q=' + encodeURIComponent(name)
  const resp = await axios.get(url)
  const firstMatch = resp.data.results[0]
  if (!firstMatch) {
    log('no matches')
    return
  }
  const isReallyMatch = firstMatch.name === name
  if (!isReallyMatch) {
    log('Not really a match: ' + firstMatch.name)
    return
  }
  const val = firstMatch.preferred_common_name
  altSpecies[name] = val
  isAltSpeciesDirty = true
  log('Match found: ' + val)
}

async function updateOnRemote(csvRecord, remoteRecord) {
  const obsId = remoteRecord.id
  await postObsField(obsId, orchidTypeId, csvRecord.orchidType)
  await postObsField(obsId, accuracyId, csvRecord.accuracy)
  await postObsField(obsId, countId, csvRecord.count)
  const patch = {}
  if (csvRecord.date.isUsStyle) {
    patch.observed_on_string = csvRecord.date.fixedVal
  }
  await updateObs(obsId, patch)
}

async function updateObs(obsId, patch) {
  const body = {
    observation: patch,
    project_id: wowProjectId,
    ignore_photos: true, // otherwise we lose them :(
  }
  // log('PUT to /obs', body)
  const url = `/observations/${obsId}`
  log('Updating obs', body)
  const resp = await axios.put(url, body)
  checkStatus(resp)
  const projObsUuid = resp.data.project_observations[0].uuid
  if (!projObsUuid) {
    throw new Error('No proj obs UUID')
  }
  const url2 = `/project_observations/${projObsUuid}`
  log(`Granting curator access`)
  const resp2 = await axios.put(url2, {
    id: projObsUuid,
    project_observation: { prefers_curator_coordinate_access: 1 },
  })
  checkStatus(resp2)
}

async function postObsField(observation_id, observation_field_id, value) {
  log(`Updating obs field ${observation_field_id}=${value}`)
  const resp = await axios.post('/observation_field_values', {
    observation_field_value: { observation_id, observation_field_id, value },
  })
  checkStatus(resp)
  return resp.data
}

function checkStatus(resp) {
  const s = resp.status
  if (s < 200 || s > 299) {
    throw new Error(
      `Failed to make request, got status=${s}, body=${resp.data}`,
    )
  }
}

async function getDataFromInat() {
  if (!fs.existsSync(cachedInatDataFilename)) {
    log(`no cached file "${cachedInatDataFilename}", pulling new data`)
    const url =
      'https://www.inaturalist.org/observations/gguer' +
      '?q=class-bulkobservationfile-user_id-1911933-filename-wild-orchid-watch-austra' +
      'lia_grg-csv-project_id-65697-2020-09-24%2003:49:24%20-0700.csv' +
      '&search_on=tags'
    const resp = await axios.get(url, {
      headers: {
        accept: 'application/json',
        Cookie: '_inaturalist_session=' + sessionId,
      },
    })
    const body = resp.data
    fs.writeFileSync(cachedInatDataFilename, JSON.stringify(body, null, 2))
  } else {
    log('Cache exists, using it')
  }
  const cached = JSON.parse(fs.readFileSync(cachedInatDataFilename))
  const mapped = cached.map(e => {
    return Object.keys(e).reduce((accum, currKey) => {
      const isSelected = !!~fields.indexOf(currKey)
      if (isSelected) {
        accum[currKey] = e[currKey]
      }
      return accum
    }, {})
  })
  return mapped
}

async function readCsv() {
  const data = await new Promise(res => {
    const results = []
    fs.createReadStream('grg.csv')
      .pipe(csv())
      .on('data', data => results.push(data))
      .on('end', () => {
        return res(results)
      })
  })
  return data.map(e => ({
    lat: e['Latitude / y coord / northing'],
    lng: e['Longitude / x coord / easting'],
    speciesGuess: e['species guess'],
    orchidType: e['WOW Orchid type*'],
    accuracy: e['WOW Accuracy of population count*'],
    count: ['WOW Number of individuals recorded*'],
    date: getDate(e['Date']),
    orchidType: e['WOW Orchid type*'],
    accuracy: e['WOW Accuracy of population count*'],
    count: e['WOW Number of individuals recorded*'],
  }))
}

function getDate(dateStr) {
  const datesThatWerentMunged = ['4/9/19'] // I dunno why :'(
  const wasParsedWrong =
    dateStr.replace(/\/.*/, '') <= 12 &&
    !datesThatWerentMunged.includes(dateStr)
  if (wasParsedWrong) {
    const parsed = dayjs(dateStr, 'D/M/YY')
    return {
      isUsStyle: true,
      val: parsed.format('YYYY-DD-MM'),
      fixedVal: parsed.format('YYYY-MM-DD'),
    }
  } else {
    return { val: dayjs(dateStr, 'D/M/YY').format('YYYY-MM-DD') }
  }
}

function log(...argz) {
  console.log(new Date().toISOString(), ...argz)
}
