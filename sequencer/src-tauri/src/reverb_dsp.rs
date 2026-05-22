/* ------------------------------------------------------------
author: "newspeech"
name: "Reverb"
Code generated with Faust 2.85.5 (https://faust.grame.fr)
Compilation options: -lang rust -fpga-mem-th 4 -ct 1 -es 1 -mcd 16 -mdd 1024 -mdy 33 -single -ftz 0
------------------------------------------------------------ */

#[repr(C)]
pub struct mydsp {
	fHslider0: FaustFloat,
	fHslider1: FaustFloat,
	iVec0: [i32;2],
	fHslider2: FaustFloat,
	IOTA0: i32,
	fVec1: [F32;1024],
	fSampleRate: i32,
	fConst0: F32,
	iConst1: i32,
	fRec15: [F32;2],
	fVec2: [F32;1024],
	iConst2: i32,
	fRec13: [F32;2],
	fVec3: [F32;2048],
	iConst3: i32,
	fRec11: [F32;2],
	fVec4: [F32;4096],
	iConst4: i32,
	fRec9: [F32;2],
	fHslider3: FaustFloat,
	fConst5: F32,
	fConst6: F32,
	fRec18: [F32;2],
	fRec8: [F32;2],
	fVec6: [F32;16384],
	iConst7: i32,
	fRec6: [F32;2],
	fVec7: [F32;16384],
	iConst8: i32,
	fRec4: [F32;2],
	fRec0: [F32;32768],
	iConst9: i32,
	fConst10: F32,
	fConst11: F32,
	fConst12: F32,
	iConst13: i32,
	fConst14: F32,
	iConst15: i32,
	fRec23: [F32;2],
	fVec8: [F32;16384],
	iConst16: i32,
	fRec21: [F32;2],
	fVec9: [F32;16384],
	iConst17: i32,
	fRec19: [F32;2],
	fRec1: [F32;32768],
}



pub struct mydspSIG0 {
	iVec5: [i32;2],
	iRec17: [i32;2],
	fSampleRate: i32,
}

impl mydspSIG0 {
	
	fn get_num_inputsmydspSIG0(&self) -> i32 {
		return 0;
	}
	fn get_num_outputsmydspSIG0(&self) -> i32 {
		return 1;
	}
	
	pub fn instance_initmydspSIG0(&mut self, sample_rate: i32) {
		self.fSampleRate = sample_rate;
		for l9 in 0..2 {
			self.iVec5[l9 as usize] = 0;
		}
		for l10 in 0..2 {
			self.iRec17[l10 as usize] = 0;
		}
	}
	
	pub fn fillmydspSIG0(&mut self, count: i32, table: &mut[F32]) {
		for i1 in 0..count {
			self.iVec5[0] = 1;
			self.iRec17[0] = (i32::wrapping_add(self.iVec5[1], self.iRec17[1])) % 65536;
			table[i1 as usize] = F32::sin(9.58738e-05 * (self.iRec17[0]) as F32);
			self.iVec5[1] = self.iVec5[0];
			self.iRec17[1] = self.iRec17[0];
		}
	}

}


pub fn newmydspSIG0() -> mydspSIG0 { 
	mydspSIG0 {
		iVec5: [0;2],
		iRec17: [0;2],
		fSampleRate: 0,
	}
}
static ftbl0mydspSIG0: std::sync::RwLock<[F32;65536]>  = std::sync::RwLock::new([0.0;65536]);
pub const FAUST_INPUTS: usize = 2;
pub const FAUST_OUTPUTS: usize = 2;
pub const FAUST_ACTIVES: usize = 4;
pub const FAUST_PASSIVES: usize = 0;

impl mydsp {
		
	pub fn new() -> mydsp { 
		mydsp {
			fHslider0: 0.0,
			fHslider1: 0.0,
			iVec0: [0;2],
			fHslider2: 0.0,
			IOTA0: 0,
			fVec1: [0.0;1024],
			fSampleRate: 0,
			fConst0: 0.0,
			iConst1: 0,
			fRec15: [0.0;2],
			fVec2: [0.0;1024],
			iConst2: 0,
			fRec13: [0.0;2],
			fVec3: [0.0;2048],
			iConst3: 0,
			fRec11: [0.0;2],
			fVec4: [0.0;4096],
			iConst4: 0,
			fRec9: [0.0;2],
			fHslider3: 0.0,
			fConst5: 0.0,
			fConst6: 0.0,
			fRec18: [0.0;2],
			fRec8: [0.0;2],
			fVec6: [0.0;16384],
			iConst7: 0,
			fRec6: [0.0;2],
			fVec7: [0.0;16384],
			iConst8: 0,
			fRec4: [0.0;2],
			fRec0: [0.0;32768],
			iConst9: 0,
			fConst10: 0.0,
			fConst11: 0.0,
			fConst12: 0.0,
			iConst13: 0,
			fConst14: 0.0,
			iConst15: 0,
			fRec23: [0.0;2],
			fVec8: [0.0;16384],
			iConst16: 0,
			fRec21: [0.0;2],
			fVec9: [0.0;16384],
			iConst17: 0,
			fRec19: [0.0;2],
			fRec1: [0.0;32768],
		}
	}
	pub fn metadata(&self, m: &mut dyn Meta) { 
		m.declare("author", r"newspeech");
		m.declare("basics.lib/name", r"Faust Basic Element Library");
		m.declare("basics.lib/version", r"1.22.0");
		m.declare("compile_options", r"-lang rust -fpga-mem-th 4 -ct 1 -es 1 -mcd 16 -mdd 1024 -mdy 33 -single -ftz 0");
		m.declare("delays.lib/name", r"Faust Delay Library");
		m.declare("delays.lib/version", r"1.2.0");
		m.declare("description", r"Clouds-flavoured Griesinger plate reverb");
		m.declare("filename", r"reverb.dsp");
		m.declare("filters.lib/allpass_comb:author", r"Julius O. Smith III");
		m.declare("filters.lib/allpass_comb:copyright", r"Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>");
		m.declare("filters.lib/allpass_comb:license", r"MIT-style STK-4.3 license");
		m.declare("filters.lib/lowpass0_highpass1", r"Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>");
		m.declare("filters.lib/name", r"Faust Filters Library");
		m.declare("filters.lib/pole:author", r"Julius O. Smith III");
		m.declare("filters.lib/pole:copyright", r"Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu>");
		m.declare("filters.lib/pole:license", r"MIT-style STK-4.3 license");
		m.declare("filters.lib/version", r"1.7.1");
		m.declare("maths.lib/author", r"GRAME");
		m.declare("maths.lib/copyright", r"GRAME");
		m.declare("maths.lib/license", r"LGPL with exception");
		m.declare("maths.lib/name", r"Faust Math Library");
		m.declare("maths.lib/version", r"2.9.0");
		m.declare("name", r"Reverb");
		m.declare("oscillators.lib/name", r"Faust Oscillator Library");
		m.declare("oscillators.lib/version", r"1.7.0");
		m.declare("platform.lib/name", r"Generic Platform Library");
		m.declare("platform.lib/version", r"1.3.0");
	}

	pub fn get_sample_rate(&self) -> i32 { self.fSampleRate as i32}
	
	pub fn class_init(sample_rate: i32) {
		// Obtaining locks on 1 static var(s)
		let mut ftbl0mydspSIG0_guard = ftbl0mydspSIG0.write().unwrap();
		let mut sig0: mydspSIG0 = newmydspSIG0();
		sig0.instance_initmydspSIG0(sample_rate);
		sig0.fillmydspSIG0(65536, ftbl0mydspSIG0_guard.as_mut());
	}
	pub fn instance_reset_params(&mut self) {
		self.fHslider0 = (0.4) as FaustFloat;
		self.fHslider1 = (0.4) as FaustFloat;
		self.fHslider2 = (0.625) as FaustFloat;
		self.fHslider3 = (0.7) as FaustFloat;
	}
	pub fn instance_clear(&mut self) {
		for l0 in 0..2 {
			self.iVec0[l0 as usize] = 0;
		}
		self.IOTA0 = 0;
		for l1 in 0..1024 {
			self.fVec1[l1 as usize] = 0.0;
		}
		for l2 in 0..2 {
			self.fRec15[l2 as usize] = 0.0;
		}
		for l3 in 0..1024 {
			self.fVec2[l3 as usize] = 0.0;
		}
		for l4 in 0..2 {
			self.fRec13[l4 as usize] = 0.0;
		}
		for l5 in 0..2048 {
			self.fVec3[l5 as usize] = 0.0;
		}
		for l6 in 0..2 {
			self.fRec11[l6 as usize] = 0.0;
		}
		for l7 in 0..4096 {
			self.fVec4[l7 as usize] = 0.0;
		}
		for l8 in 0..2 {
			self.fRec9[l8 as usize] = 0.0;
		}
		for l11 in 0..2 {
			self.fRec18[l11 as usize] = 0.0;
		}
		for l12 in 0..2 {
			self.fRec8[l12 as usize] = 0.0;
		}
		for l13 in 0..16384 {
			self.fVec6[l13 as usize] = 0.0;
		}
		for l14 in 0..2 {
			self.fRec6[l14 as usize] = 0.0;
		}
		for l15 in 0..16384 {
			self.fVec7[l15 as usize] = 0.0;
		}
		for l16 in 0..2 {
			self.fRec4[l16 as usize] = 0.0;
		}
		for l17 in 0..32768 {
			self.fRec0[l17 as usize] = 0.0;
		}
		for l18 in 0..2 {
			self.fRec23[l18 as usize] = 0.0;
		}
		for l19 in 0..16384 {
			self.fVec8[l19 as usize] = 0.0;
		}
		for l20 in 0..2 {
			self.fRec21[l20 as usize] = 0.0;
		}
		for l21 in 0..16384 {
			self.fVec9[l21 as usize] = 0.0;
		}
		for l22 in 0..2 {
			self.fRec19[l22 as usize] = 0.0;
		}
		for l23 in 0..32768 {
			self.fRec1[l23 as usize] = 0.0;
		}
	}
	pub fn instance_constants(&mut self, sample_rate: i32) {
		// Obtaining locks on 1 static var(s)
		let ftbl0mydspSIG0_guard = ftbl0mydspSIG0.read().unwrap();
		self.fSampleRate = sample_rate;
		self.fConst0 = F32::min(1.92e+05, F32::max(1.0, (self.fSampleRate) as F32));
		self.iConst1 = core::cmp::min(512, core::cmp::max(0, i32::wrapping_add((0.00353125 * self.fConst0) as i32, -1)));
		self.iConst2 = core::cmp::min(512, core::cmp::max(0, i32::wrapping_add((0.0050625 * self.fConst0) as i32, -1)));
		self.iConst3 = core::cmp::min(1024, core::cmp::max(0, i32::wrapping_add((0.00753125 * self.fConst0) as i32, -1)));
		self.iConst4 = core::cmp::min(2048, core::cmp::max(0, i32::wrapping_add((0.01246875 * self.fConst0) as i32, -1)));
		self.fConst5 = 3.125e-05 * self.fConst0;
		self.fConst6 = 0.3 / self.fConst0;
		self.iConst7 = core::cmp::min(8192, core::cmp::max(0, i32::wrapping_add((0.05165625 * self.fConst0) as i32, -1)));
		self.iConst8 = core::cmp::min(8192, core::cmp::max(0, i32::wrapping_add((0.0636875 * self.fConst0) as i32, -1)));
		self.iConst9 = (0.10659375 * self.fConst0) as i32;
		self.fConst10 = (self.iConst9) as F32;
		self.fConst11 = F32::floor(self.fConst10);
		self.fConst12 = self.fConst11 + (1.0 - self.fConst10);
		self.iConst13 = i32::wrapping_add(core::cmp::min(16385, core::cmp::max(0, self.iConst9)), 1);
		self.fConst14 = self.fConst10 - self.fConst11;
		self.iConst15 = i32::wrapping_add(core::cmp::min(16385, core::cmp::max(0, i32::wrapping_add(self.iConst9, 1))), 1);
		self.iConst16 = core::cmp::min(8192, core::cmp::max(0, i32::wrapping_add((0.05978125 * self.fConst0) as i32, -1)));
		self.iConst17 = core::cmp::min(8192, core::cmp::max(0, i32::wrapping_add((0.05196875 * self.fConst0) as i32, -1)));
	}
	pub fn instance_init(&mut self, sample_rate: i32) {
		self.instance_constants(sample_rate);
		self.instance_reset_params();
		self.instance_clear();
	}
	pub fn init(&mut self, sample_rate: i32) {
		mydsp::class_init(sample_rate);
		self.instance_init(sample_rate);
	}
	
	pub fn build_user_interface(&self, ui_interface: &mut dyn UI<FaustFloat>) {
		Self::build_user_interface_static(ui_interface);
	}
	
	pub fn build_user_interface_static(ui_interface: &mut dyn UI<FaustFloat>) {
		ui_interface.open_vertical_box("Reverb");
		ui_interface.add_horizontal_slider("damping", ParamIndex(0), 0.4, 0.0, 1.0, 0.001);
		ui_interface.add_horizontal_slider("diffusion", ParamIndex(1), 0.625, 0.0, 0.85, 0.001);
		ui_interface.add_horizontal_slider("mix", ParamIndex(2), 0.4, 0.0, 1.0, 0.001);
		ui_interface.add_horizontal_slider("size", ParamIndex(3), 0.7, 0.0, 1.0, 0.001);
		ui_interface.close_box();
	}
	
	pub fn get_param(&self, param: ParamIndex) -> Option<FaustFloat> {
		match param.0 {
			2 => Some(self.fHslider0),
			0 => Some(self.fHslider1),
			1 => Some(self.fHslider2),
			3 => Some(self.fHslider3),
			_ => None,
		}
	}
	
	pub fn set_param(&mut self, param: ParamIndex, value: FaustFloat) {
		match param.0 {
			2 => { self.fHslider0 = value }
			0 => { self.fHslider1 = value }
			1 => { self.fHslider2 = value }
			3 => { self.fHslider3 = value }
			_ => {}
		}
	}
	
	pub fn compute(
		&mut self,
		count: usize,
		inputs: &[impl AsRef<[FaustFloat]>],
		outputs: &mut[impl AsMut<[FaustFloat]>],
	) {
		
		// Obtaining locks on 1 static var(s)
		let ftbl0mydspSIG0_guard = ftbl0mydspSIG0.read().unwrap();
		let [inputs0, inputs1, .. ] = inputs.as_ref() else { panic!("wrong number of input buffers"); };
		let inputs0 = inputs0.as_ref()[..count].iter();
		let inputs1 = inputs1.as_ref()[..count].iter();
		let [outputs0, outputs1, .. ] = outputs.as_mut() else { panic!("wrong number of output buffers"); };
		let outputs0 = outputs0.as_mut()[..count].iter_mut();
		let outputs1 = outputs1.as_mut()[..count].iter_mut();
		let mut fSlow0: F32 = (self.fHslider0) as F32;
		let mut fSlow1: F32 = 1.0 - fSlow0;
		let mut fSlow2: F32 = 0.7 * (self.fHslider1) as F32;
		let mut fSlow3: F32 = 1.0 - fSlow2;
		let mut fSlow4: F32 = (self.fHslider2) as F32;
		let mut fSlow5: F32 = (self.fHslider3) as F32;
		let mut fSlow6: F32 = 0.62 * fSlow5 + 0.3;
		let mut fSlow7: F32 = 1.5 - 1.2 * fSlow5;
		let zipped_iterators = inputs0.zip(inputs1).zip(outputs0).zip(outputs1);
		for (((input0, input1), output0), output1) in zipped_iterators {
			let mut fTemp0: F32 = (*input0) as F32;
			self.iVec0[0] = 1;
			let mut fTemp1: F32 = (*input1) as F32;
			let mut fTemp2: F32 = 0.5 * (fTemp0 + fTemp1) - fSlow4 * self.fRec15[1];
			self.fVec1[(self.IOTA0 & 1023) as usize] = fTemp2;
			self.fRec15[0] = self.fVec1[((i32::wrapping_sub(self.IOTA0, self.iConst1)) & 1023) as usize];
			let mut fRec16: F32 = fSlow4 * fTemp2;
			let mut fTemp3: F32 = fRec16 + self.fRec15[1] - fSlow4 * self.fRec13[1];
			self.fVec2[(self.IOTA0 & 1023) as usize] = fTemp3;
			self.fRec13[0] = self.fVec2[((i32::wrapping_sub(self.IOTA0, self.iConst2)) & 1023) as usize];
			let mut fRec14: F32 = fSlow4 * fTemp3;
			let mut fTemp4: F32 = fRec14 + self.fRec13[1] - fSlow4 * self.fRec11[1];
			self.fVec3[(self.IOTA0 & 2047) as usize] = fTemp4;
			self.fRec11[0] = self.fVec3[((i32::wrapping_sub(self.IOTA0, self.iConst3)) & 2047) as usize];
			let mut fRec12: F32 = fSlow4 * fTemp4;
			let mut fTemp5: F32 = fRec12 + self.fRec11[1] - fSlow4 * self.fRec9[1];
			self.fVec4[(self.IOTA0 & 4095) as usize] = fTemp5;
			self.fRec9[0] = self.fVec4[((i32::wrapping_sub(self.IOTA0, self.iConst4)) & 4095) as usize];
			let mut fRec10: F32 = fSlow4 * fTemp5;
			let mut fTemp6: F32 = fRec10 + self.fRec9[1];
			let mut fTemp7: F32 = (if i32::wrapping_sub(1, self.iVec0[1]) != 0 {0.0} else {self.fConst6 + self.fRec18[1]});
			self.fRec18[0] = fTemp7 - F32::floor(fTemp7);
			let mut fTemp8: F32 = self.fConst5 * (1e+02 * ftbl0mydspSIG0_guard[(core::cmp::max(0, core::cmp::min((65536.0 * self.fRec18[0]) as i32, 65535))) as usize] + 4782.0);
			let mut iTemp9: i32 = (fTemp8) as i32;
			let mut fTemp10: F32 = F32::floor(fTemp8);
			self.fRec8[0] = fSlow2 * self.fRec8[1] + fSlow3 * (fTemp6 + fSlow6 * (self.fRec1[((i32::wrapping_sub(self.IOTA0, i32::wrapping_add(core::cmp::min(16385, core::cmp::max(0, iTemp9)), 1))) & 32767) as usize] * (fTemp10 + (1.0 - fTemp8)) + (fTemp8 - fTemp10) * self.fRec1[((i32::wrapping_sub(self.IOTA0, i32::wrapping_add(core::cmp::min(16385, core::cmp::max(0, i32::wrapping_add(iTemp9, 1))), 1))) & 32767) as usize]));
			let mut fTemp11: F32 = self.fRec8[0] + fSlow4 * self.fRec6[1];
			self.fVec6[(self.IOTA0 & 16383) as usize] = fTemp11;
			self.fRec6[0] = self.fVec6[((i32::wrapping_sub(self.IOTA0, self.iConst7)) & 16383) as usize];
			let mut fRec7: F32 = -(fSlow4 * fTemp11);
			let mut fTemp12: F32 = fRec7 + self.fRec6[1] - fSlow4 * self.fRec4[1];
			self.fVec7[(self.IOTA0 & 16383) as usize] = fTemp12;
			self.fRec4[0] = self.fVec7[((i32::wrapping_sub(self.IOTA0, self.iConst8)) & 16383) as usize];
			let mut fRec5: F32 = fSlow4 * fTemp12;
			let mut fTemp13: F32 = fRec5 + self.fRec4[1];
			self.fRec0[(self.IOTA0 & 32767) as usize] = fTemp13;
			self.fRec23[0] = fSlow2 * self.fRec23[1] + fSlow3 * (fTemp6 + fSlow6 * (self.fConst12 * self.fRec0[((i32::wrapping_sub(self.IOTA0, self.iConst13)) & 32767) as usize] + self.fConst14 * self.fRec0[((i32::wrapping_sub(self.IOTA0, self.iConst15)) & 32767) as usize]));
			let mut fTemp14: F32 = self.fRec23[0] - fSlow4 * self.fRec21[1];
			self.fVec8[(self.IOTA0 & 16383) as usize] = fTemp14;
			self.fRec21[0] = self.fVec8[((i32::wrapping_sub(self.IOTA0, self.iConst16)) & 16383) as usize];
			let mut fRec22: F32 = fSlow4 * fTemp14;
			let mut fTemp15: F32 = self.fRec21[1] + fRec22 + fSlow4 * self.fRec19[1];
			self.fVec9[(self.IOTA0 & 16383) as usize] = fTemp15;
			self.fRec19[0] = self.fVec9[((i32::wrapping_sub(self.IOTA0, self.iConst17)) & 16383) as usize];
			let mut fRec20: F32 = -(fSlow4 * fTemp15);
			let mut fTemp16: F32 = fRec20 + self.fRec19[1];
			self.fRec1[(self.IOTA0 & 32767) as usize] = fTemp16;
			let mut fRec2: F32 = fSlow7 * fTemp13;
			let mut fRec3: F32 = fSlow7 * fTemp16;
			*output0 = (fSlow1 * fTemp0 + fSlow0 * fRec2) as FaustFloat;
			*output1 = (fSlow1 * fTemp1 + fSlow0 * fRec3) as FaustFloat;
			self.iVec0[1] = self.iVec0[0];
			self.IOTA0 = i32::wrapping_add(self.IOTA0, 1);
			self.fRec15[1] = self.fRec15[0];
			self.fRec13[1] = self.fRec13[0];
			self.fRec11[1] = self.fRec11[0];
			self.fRec9[1] = self.fRec9[0];
			self.fRec18[1] = self.fRec18[0];
			self.fRec8[1] = self.fRec8[0];
			self.fRec6[1] = self.fRec6[0];
			self.fRec4[1] = self.fRec4[0];
			self.fRec23[1] = self.fRec23[0];
			self.fRec21[1] = self.fRec21[0];
			self.fRec19[1] = self.fRec19[0];
		}
		
	}

}

#[cfg(not(target_arch = "wasm32"))] // Compile ffi bindings only on non-wasm targets
mod ffi {
	use core::ffi::c_float;
	// Conditionally compile the link attribute only on non-Windows platforms
	#[cfg_attr(not(target_os = "windows"), link(name = "m"))]
	unsafe extern "C" {
		pub fn remainderf(from: c_float, to: c_float) -> c_float;
		pub fn rintf(val: c_float) -> c_float;
	}
}
fn remainderf(from: f32, to: f32) -> f32 {
	#[cfg(not(target_arch = "wasm32"))] // non-wasm targets use ffi bindings
	unsafe { ffi::remainderf(from, to) }
	#[cfg(target_arch = "wasm32")] // wasm relies on libm
	libm::remainderf(from, to)
}
fn rintf(val: f32) -> f32 {
	#[cfg(not(target_arch = "wasm32"))] // non-wasm targets use ffi bindings
	unsafe { ffi::rintf(val) }
	#[cfg(target_arch = "wasm32")] // wasm relies on libm
	libm::rintf(val)
}

impl FaustDsp for mydsp {
	type T = FaustFloat;
	fn new() -> Self where Self: Sized {
		Self::new()
	}
	fn metadata(&self, m: &mut dyn Meta) {
		self.metadata(m)
	}
	fn get_sample_rate(&self) -> i32 {
		self.get_sample_rate()
	}
	fn get_num_inputs(&self) -> i32 {
		FAUST_INPUTS as i32
	}
	fn get_num_outputs(&self) -> i32 {
		FAUST_OUTPUTS as i32
	}
	fn class_init(sample_rate: i32) where Self: Sized {
		Self::class_init(sample_rate);
	}
	fn instance_reset_params(&mut self) {
		self.instance_reset_params()
	}
	fn instance_clear(&mut self) {
		self.instance_clear()
	}
	fn instance_constants(&mut self, sample_rate: i32) {
		self.instance_constants(sample_rate)
	}
	fn instance_init(&mut self, sample_rate: i32) {
		self.instance_init(sample_rate)
	}
	fn init(&mut self, sample_rate: i32) {
		self.init(sample_rate)
	}
	fn build_user_interface(&self, ui_interface: &mut dyn UI<Self::T>) {
		self.build_user_interface(ui_interface)
	}
	fn build_user_interface_static(ui_interface: &mut dyn UI<Self::T>) where Self: Sized {
		Self::build_user_interface_static(ui_interface);
	}
	fn get_param(&self, param: ParamIndex) -> Option<Self::T> {
		self.get_param(param)
	}
	fn set_param(&mut self, param: ParamIndex, value: Self::T) {
		self.set_param(param, value)
	}
	fn compute(&mut self, count: i32, inputs: &[&[Self::T]], outputs: &mut [&mut [Self::T]]) {
		self.compute(count as usize, inputs, outputs)
	}
}
