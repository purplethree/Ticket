'use strict';

/**
 * ICAO aircraft type designators (ICAO Doc 8643) → readable names.
 *
 * Only used to decode the real `aircraft_icao` code returned by the flight
 * API when the API does not also return a model name. Unknown codes are shown
 * as-is; nothing is guessed.
 *
 * Note: one designator can cover several variants (e.g. A21N is used for both
 * the A321neo and the A321LR), so the generic family name is used.
 */
const TYPES = {
  // Airbus
  A124: 'Antonov An-124',
  A19N: 'Airbus A319neo',
  A20N: 'Airbus A320neo',
  A21N: 'Airbus A321neo',
  A306: 'Airbus A300-600',
  A30B: 'Airbus A300',
  A310: 'Airbus A310',
  A318: 'Airbus A318',
  A319: 'Airbus A319',
  A320: 'Airbus A320',
  A321: 'Airbus A321',
  A332: 'Airbus A330-200',
  A333: 'Airbus A330-300',
  A337: 'Airbus BelugaXL',
  A338: 'Airbus A330-800neo',
  A339: 'Airbus A330-900neo',
  A342: 'Airbus A340-200',
  A343: 'Airbus A340-300',
  A345: 'Airbus A340-500',
  A346: 'Airbus A340-600',
  A359: 'Airbus A350-900',
  A35K: 'Airbus A350-1000',
  A388: 'Airbus A380-800',
  BCS1: 'Airbus A220-100',
  BCS3: 'Airbus A220-300',
  // Boeing
  B37M: 'Boeing 737 MAX 7',
  B38M: 'Boeing 737 MAX 8',
  B39M: 'Boeing 737 MAX 9',
  B3XM: 'Boeing 737 MAX 10',
  B712: 'Boeing 717',
  B732: 'Boeing 737-200',
  B733: 'Boeing 737-300',
  B734: 'Boeing 737-400',
  B735: 'Boeing 737-500',
  B736: 'Boeing 737-600',
  B737: 'Boeing 737-700',
  B738: 'Boeing 737-800',
  B739: 'Boeing 737-900',
  B742: 'Boeing 747-200',
  B744: 'Boeing 747-400',
  B748: 'Boeing 747-8',
  B74S: 'Boeing 747SP',
  B752: 'Boeing 757-200',
  B753: 'Boeing 757-300',
  B762: 'Boeing 767-200',
  B763: 'Boeing 767-300',
  B764: 'Boeing 767-400',
  B772: 'Boeing 777-200',
  B77L: 'Boeing 777-200LR',
  B773: 'Boeing 777-300',
  B77W: 'Boeing 777-300ER',
  B778: 'Boeing 777-8',
  B779: 'Boeing 777-9',
  B788: 'Boeing 787-8',
  B789: 'Boeing 787-9',
  B78X: 'Boeing 787-10',
  // Embraer
  E135: 'Embraer ERJ-135',
  E145: 'Embraer ERJ-145',
  E170: 'Embraer E170',
  E75L: 'Embraer E175',
  E75S: 'Embraer E175',
  E175: 'Embraer E175',
  E190: 'Embraer E190',
  E195: 'Embraer E195',
  E290: 'Embraer E190-E2',
  E295: 'Embraer E195-E2',
  // Bombardier / De Havilland / Mitsubishi
  CRJ2: 'Bombardier CRJ200',
  CRJ7: 'Bombardier CRJ700',
  CRJ9: 'Bombardier CRJ900',
  CRJX: 'Bombardier CRJ1000',
  DH8A: 'Dash 8-100',
  DH8B: 'Dash 8-200',
  DH8C: 'Dash 8-300',
  DH8D: 'Dash 8-400',
  // ATR
  AT43: 'ATR 42-300',
  AT45: 'ATR 42-500',
  AT46: 'ATR 42-600',
  AT72: 'ATR 72',
  AT75: 'ATR 72-500',
  AT76: 'ATR 72-600',
  // Others
  C919: 'COMAC C919',
  AJ27: 'COMAC ARJ21',
  SU95: 'Sukhoi Superjet 100',
  MD11: 'McDonnell Douglas MD-11',
  MD82: 'McDonnell Douglas MD-82',
  MD83: 'McDonnell Douglas MD-83',
  MD88: 'McDonnell Douglas MD-88',
  MD90: 'McDonnell Douglas MD-90',
  F70: 'Fokker 70',
  F100: 'Fokker 100',
  RJ85: 'Avro RJ85',
  RJ1H: 'Avro RJ100',
  B463: 'BAe 146-300',
  SF34: 'Saab 340',
  SB20: 'Saab 2000',
  JS41: 'BAe Jetstream 41',
  D328: 'Dornier 328',
  J328: 'Dornier 328JET',
  A748: 'Hawker Siddeley HS 748',
  AN24: 'Antonov An-24',
  AN26: 'Antonov An-26',
  IL96: 'Ilyushin Il-96',
  T204: 'Tupolev Tu-204',
  DHC6: 'DHC-6 Twin Otter',
  BE20: 'Beechcraft King Air 200',
  C208: 'Cessna 208 Caravan',
  PC12: 'Pilatus PC-12',
};

function aircraftName(icao) {
  if (!icao) return null;
  return TYPES[String(icao).toUpperCase()] || null;
}

module.exports = { aircraftName };
