import { Schema, model} from "mongoose";

const userSchema = new Schema({
    username: {
        type: String,
        required: true,
        unique: true,
    },

    email: {
        type: String,
        required: true,
        unique: true,
        validator: {
            validator: function (v) {
                return /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/.test(v);
            },
            message: props => `${props.value} is not a valid email!`
        },
    },

    posts: [
        {
            type: Schema.Types.ObjectId,
            ref: "Post",
        }
    ],

    profile: {
        type: Schema.Types.ObjectId,
        ref: "Profile",
    }
}, { timestamps: true });

export const User = model("User", userSchema);
