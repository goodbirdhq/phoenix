// Load before the app and its dependencies: mobile and shared code use these
// copy-by-value array methods, which vary between shipped Hermes versions.
import "core-js/actual/array/to-sorted.js";
import "core-js/actual/array/to-reversed.js";
