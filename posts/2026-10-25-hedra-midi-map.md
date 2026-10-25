---
title: meris hedra midi-mapping
date: 2026-10-25
dek: someone is going to find this post and be very thankful someday
image: assets/hedra-midi-map.jpg
image_alt: the meris hedra, pitch 1, 2 and 3 knobs up front, midi channel 15 taped on
---

ok so this is a post for basically nobody but I was trying to build a midi mapping into some EDIT software that i've created to manage all of my synth presets and midi devices and realized that the mapping for the individual keys and pitches isn't clearly articulated within the meris manual. I probably could have emailed for this but instead ran some test tones through it and measured the results. 

## pitch 1, 2 and 3

CC 19, 20 and 21. All three knobs share one map: eighteen positions, a scale degree every 8 values, with unison at 60–67. The intervals are diatonic, so the semitones depend on Key and Scale Type. The right-hand columns are C major with a C going in.

<div class="table"><table>
<thead><tr><th>cc value</th><th>interval</th><th>from C</th><th>semitones</th></tr></thead>
<tbody>
<tr><td>0</td><td>off</td><td>—</td><td>—</td></tr>
<tr><td>1–7</td><td>−2 oct</td><td>C</td><td>−24</td></tr>
<tr><td>8–11</td><td>−oct</td><td>C</td><td>−12</td></tr>
<tr><td>12–19</td><td>−7th</td><td>D</td><td>−10</td></tr>
<tr><td>20–27</td><td>−6th</td><td>E</td><td>−8</td></tr>
<tr><td>28–35</td><td>−5th</td><td>F</td><td>−7</td></tr>
<tr><td>36–43</td><td>−4th</td><td>G</td><td>−5</td></tr>
<tr><td>44–51</td><td>−3rd</td><td>A</td><td>−3</td></tr>
<tr><td>52–59</td><td>−2nd</td><td>B</td><td>−1</td></tr>
<tr><td>60–67</td><td>unison</td><td>C</td><td>0</td></tr>
<tr><td>68–75</td><td>+2nd</td><td>D</td><td>+2</td></tr>
<tr><td>76–83</td><td>+3rd</td><td>E</td><td>+4</td></tr>
<tr><td>84–91</td><td>+4th</td><td>F</td><td>+5</td></tr>
<tr><td>92–99</td><td>+5th</td><td>G</td><td>+7</td></tr>
<tr><td>100–107</td><td>+6th</td><td>A</td><td>+9</td></tr>
<tr><td>108–115</td><td>+7th</td><td>B</td><td>+11</td></tr>
<tr><td>116–119</td><td>+oct</td><td>C</td><td>+12</td></tr>
<tr><td>120–127</td><td>+2 oct</td><td>C</td><td>+24</td></tr>
</tbody>
</table></div>

## key

CC 16. Thirteen positions, unevenly spread: C gets only 0–2, D gets fourteen values. Split the range evenly and D♭ lands on D.

<div class="table"><table>
<thead><tr><th>cc value</th><th>key</th><th>send</th></tr></thead>
<tbody>
<tr><td>0–2</td><td>C</td><td>1</td></tr>
<tr><td>3–11</td><td>D♭</td><td>7</td></tr>
<tr><td>12–25</td><td>D</td><td>18</td></tr>
<tr><td>26–37</td><td>E♭</td><td>31</td></tr>
<tr><td>38–47</td><td>E</td><td>42</td></tr>
<tr><td>48–58</td><td>F</td><td>53</td></tr>
<tr><td>59–66</td><td>G♭</td><td>62</td></tr>
<tr><td>67–77</td><td>G</td><td>72</td></tr>
<tr><td>78–87</td><td>A♭</td><td>82</td></tr>
<tr><td>88–97</td><td>A</td><td>92</td></tr>
<tr><td>98–108</td><td>B♭</td><td>103</td></tr>
<tr><td>109–119</td><td>B</td><td>114</td></tr>
<tr><td>120–127</td><td>chromatic</td><td>124</td></tr>
</tbody>
</table></div>

A note that isn't in the key borrows the intervals of a scale note beside it. Play an F# with the key on C and it gets F's intervals (2 4 6 7 9 11), so the harmony comes out in D♭ major.

## scale type

CC 22 (Alt + Key on the pedal). Seven positions. The intervals are from C with Key on C, for the Pitch positions +2nd through +7th.

<div class="table"><table>
<thead><tr><th>cc value</th><th>scale</th><th>notes</th><th>+2 … +7</th><th>send</th></tr></thead>
<tbody>
<tr><td>0–11</td><td>major</td><td>C D E F G A B</td><td>2 4 5 7 9 11</td><td>6</td></tr>
<tr><td>12–37</td><td>minor</td><td>C D E♭ F G A♭ B♭</td><td>2 3 5 7 8 10</td><td>24</td></tr>
<tr><td>38–58</td><td>melodic minor</td><td>C D E♭ F G A B</td><td>2 3 5 7 9 11</td><td>48</td></tr>
<tr><td>59–77</td><td>harmonic minor</td><td>C D E♭ F G A♭ B</td><td>2 3 5 7 8 11</td><td>68</td></tr>
<tr><td>78–97</td><td>double harmonic</td><td>C D♭ E F G A♭ B</td><td>1 4 5 7 8 11</td><td>88</td></tr>
<tr><td>98–119</td><td>lydian pentatonic</td><td>C E F# G B</td><td>4 6 7 11 12 24</td><td>108</td></tr>
<tr><td>120–127</td><td>minor pentatonic</td><td>C E♭ F G B♭</td><td>3 5 7 10 12 24</td><td>124</td></tr>
</tbody>
</table></div>

In the two pentatonics the Pitch positions walk the five notes: +6th lands on the octave, and +7th on two octaves up.

The Scale Type ranges start on every other Key boundary (12, 38, 59, 78, 98, 120), so it looks like both knobs read through the same uneven curve.

There you go one someone in the future who is looking to do this exact same thing. You're welcome. 
