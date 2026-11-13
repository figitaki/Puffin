# Revision notes

## Rev B: TRS MIDI Type A and Type B (November 2026)

Rev A wired both 3.5 mm jacks for TRS **Type A** only (traced from the netlist: on J3 MIDI OUT, ring sourced current from +5V through R4 and tip sank it into TX through R6; on J2 MIDI IN, ring fed the 6N138 LED anode through R3 and tip was the LED cathode). Rev B works with Type A and Type B gear.

### MIDI OUT (J3): firmware-selectable Type A or Type B

- Tip and ring are each driven by an ESP32-S3 GPIO through one half of **U3, a 74LVC2G34** dual buffer powered from **+3.3V**:
  - **Tip:** IO39 (ProS3 pin 21) → U3A → R6 **10 Ω** → J3 tip
  - **Ring:** IO42 (ProS3 pin 18) → U3B → R4 **33 Ω** → J3 ring
- Signalling follows the MIDI 3.3 V electrical spec (MMA CA-033): RA = 33 Ω and RC = 10 Ω, with a 43 Ω loop resistance in either mode. R4 and R6 are 0805 parts rated 0.5 W (Panasonic ERJ-P06), because in Type B the 10 Ω tip resistor becomes the source leg.
- The output now runs from +3.3V instead of the ProS3 5V pin. Rev A's output had no source supply on battery, because the ProS3 has no 5V output then. Rev B's output works on battery.
- At reset, IO39 has its internal weak pull-up and **R7 (10 k)** pulls IO42 up. Both buffer outputs are therefore HIGH, with no loop current and no stray bytes until firmware configures the pins.
- GPIO43 (ProS3 TX, the old "TX MIDI" net) is no longer connected to anything.

| Mode | Ring (IO42) | Tip (IO39) |
| --- | --- | --- |
| Type A (MMA standard, Rev A behaviour) | GPIO output, held HIGH (source) | UART TX (sink) |
| Type B | UART TX (sink) | GPIO output, held HIGH (source) |

U3 is non-inverting, so the UART polarity is unchanged: idle HIGH means no current, and a LOW bit means current flows.

### MIDI IN (J2): automatic Type A or Type B

- **D53–D56 (BAT54WS Schottky)** form a full bridge between the jack (ring through R3, and tip) and the 6N138 LED. The LED sees forward current whichever conductor sources it, so Type A and Type B senders both work with no setting.
- D52 (1N914 reverse-protection diode) was removed: the bridge never reverse-biases the LED.
- The bridge adds about 0.5 V of drop (two Schottky diodes). Typical LED current from a 3.3 V CA-033 sender is about 5 mA; the worst case is about 3 mA. That is still well above the 6N138's 1.6 mA rated input.

### Other changes

- J2/J3 part fields: the footprint and value were SJ1-3515 (through-hole), but the MPN said SJ2-3593A-SMT-TR (an SMT part, also discontinued). The MPN is now **SJ1-3515**, to match the footprint on the board.
- Parts list (`Puffin.csv`) updated: R3 220 Ω, R4 33 Ω 0.5 W, R6 10 Ω 0.5 W, R7 10 k, U3 74LVC2G34, C52 100 nF, D53–D56 BAT54WS; D52 removed.
- Layout: U3, R4, R7, and C52 sit under the ProS3 between its header rows, beside the existing R6. D53–D56 sit on the back under J2. The GND pour was refilled.
- The `Gerbers/` folder still holds Rev A output. Regenerate it after review.

### Checks (KiCad 9.0.2 CLI)

- ERC: 0 errors. Every warning is a "library not in this configuration" warning, which main also has.
- DRC with schematic parity: 0 errors and 0 unconnected items. Parity reports only BT1 (battery, no footprint), which main also reports. There are 5 new "silkscreen clipped by solder mask" warnings where the hand-drawn "ESP-32 ProS3" art crosses the new pads; the fab clips silk at mask openings.

### Firmware change needed (not implemented)

- **Pins:** MIDI OUT moves from GPIO43 to **IO39 (tip)** and **IO42 (ring)**. MIDI IN is unchanged on GPIO44 (RX).
- **Setting:** add a persisted TRS type, `A` (default, matches Rev A) or `B`, for example as an extra EEPROM byte next to the existing settings, plus a way to toggle it (a function-layer key or menu item).
- **Type A:** `pinMode(42, OUTPUT); digitalWrite(42, HIGH);` then run Serial0 with TX on 39: `Serial0.setPins(44, 39)` before `begin(31250)`.
- **Type B:** `pinMode(39, OUTPUT); digitalWrite(39, HIGH);` and TX on 42: `Serial0.setPins(44, 42)`.
- **Switching at runtime:** `Serial0.end()` (or detach the old TX pin), drive the old TX pin HIGH as a GPIO, then attach TX to the new pin. Keep the source pin HIGH whenever the UART is idle.
- `HardwareSerialMIDI_Interface midi_ser {Serial0, MIDI_BAUD}` can stay. Only the TX pin mapping changes, so set the pins before Control Surface calls `begin()`.

### Open points for review

- **Output short circuit:** U3's outputs are push-pull. A TRS plug that shorts a HIGH line to the sleeve (for example, while being inserted) asks for roughly 100 mA from one output, above the 74LVC2G34's 50 mA absolute maximum. This lasts only moments during insertion; it would be continuous only with a faulty cable.
- **Height under the ProS3:** U3 (SOT-23-6, about 1.45 mm tall) and C52 sit under the module like R6. They need the module raised on standard header spacers, not soldered flush.
- **MIDI IN supply (unchanged, pre-existing):** U2 VCC and the RX pull-up R2 (470 Ω) still go to the ProS3 5V pin. On battery, MIDI IN therefore has no supply. On USB, it pulls GPIO44 to 5 V through 470 Ω, which is outside the ESP32-S3's 3.3 V I/O rating. Moving U2 pin 8 and R2 to +3.3V would fix both. This revision does not make that change.
