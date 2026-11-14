// A custom tool file that fails to import must not stop its siblings from loading.
throw new Error("broken custom tool module")
